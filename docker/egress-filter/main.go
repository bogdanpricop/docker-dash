// dd-egress-proxy — Docker Dash Outbound Network Filter sidecar (v6.7-alpha.2)
//
// Design: see docs/planning/v6.7/outbound-filter/02-deep-spec.md §§3-5.
//
// Accepts TCP connections, peeks at the first packet to extract the
// destination hostname (TLS SNI or HTTP Host header), compares it to the
// per-container allowlist from policy.json, and either splices the
// connection to the real destination or resets.
//
// No TLS decryption. No cert injection. The filtered container sees the
// destination's real cert, never our own.
//
// In alpha.2 the sidecar runs standalone (reached via HTTP_PROXY env, or
// manual iptables redirect from the user). The egress-runner.js helper
// lands in rc1.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// ─── Config ──────────────────────────────────────────

type listenerCfg struct {
	addr         string
	policyPath   string
	metricsAddr  string
	blockLogPath string
}

func loadCfg() listenerCfg {
	return listenerCfg{
		addr:         envOr("DD_EGRESS_LISTEN", ":29193"),
		policyPath:   envOr("DD_EGRESS_POLICY_PATH", "/etc/dd-egress/policy.json"),
		metricsAddr:  envOr("DD_EGRESS_METRICS_LISTEN", ""), // empty → disabled
		blockLogPath: envOr("DD_EGRESS_BLOCKLOG_PATH", "/var/log/dd-egress/denied.log"),
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// ─── Policy ──────────────────────────────────────────

// Policy is the on-disk shape written by Docker Dash on every create/update.
// Keeping it minimal: one flat allowlist for the whole sidecar. If we need
// per-container policies later, the keyed-by-source-IP shape is a superset.
type Policy struct {
	SchemaVersion int      `json:"schema_version"`
	Version       int      `json:"version"`
	Mode          string   `json:"mode"` // "enforce" | "audit-only"
	Allowlist     []string `json:"allowlist"`
	UpdatedAt     string   `json:"updated_at"`
}

var policy atomic.Pointer[Policy]

// IMDS endpoints are ALWAYS blocked (deep-spec §13 decision 7).
var imdsEndpoints = map[string]struct{}{
	"169.254.169.254":          {},
	"metadata.google.internal": {},
	"169.254.170.2":            {}, // ECS task role
	"fd00:ec2::254":            {}, // AWS IPv6 metadata
}

func loadPolicy(path string) (*Policy, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(data) > 65536 {
		return nil, errors.New("policy unreadable or larger than 64 KiB")
	}
	var p Policy
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("parse policy: %w", err)
	}
	if p.SchemaVersion < 0 || p.SchemaVersion > 2 {
		return nil, errors.New("unsupported policy schema")
	}
	if err := normalizePolicy(&p); err != nil {
		return nil, err
	}
	return &p, nil
}

func normalizePolicy(p *Policy) error {
	if p.Mode == "" {
		p.Mode = "enforce"
	}
	if p.Mode != "enforce" && p.Mode != "audit-only" {
		return errors.New("unsupported policy mode")
	}
	// Lower-case for case-insensitive matching.
	for i, h := range p.Allowlist {
		prefix := ""
		h = strings.ToLower(strings.TrimSpace(h))
		if strings.HasPrefix(h, "*.") {
			prefix, h = "*.", h[2:]
		}
		name, port, err := destination(h, "")
		if err != nil || port != "" || (prefix != "" && net.ParseIP(name) != nil) {
			return fmt.Errorf("invalid allowlist entry %q", h)
		}
		p.Allowlist[i] = prefix + name
	}
	return nil
}

// matchAllowlist returns true if hostname is allowed by current policy.
// Supports exact match and leading-wildcard (*.example.com matches a.example.com, a.b.example.com).
func matchAllowlist(allowlist []string, hostname string) bool {
	h, _, err := destination(hostname, "")
	if err != nil {
		return false
	}
	for _, entry := range allowlist {
		if entry == h {
			return true
		}
		if strings.HasPrefix(entry, "*.") {
			suffix := entry[1:] // ".example.com"
			if strings.HasSuffix(h, suffix) && len(h) > len(suffix) {
				return true
			}
			// Also match bare suffix (example.com matches *.example.com)
			if h == suffix[1:] {
				return true
			}
		}
	}
	return false
}

func isIMDS(host string) bool {
	h, _, err := destination(host, "")
	if err != nil {
		return true
	}
	_, ok := imdsEndpoints[h]
	return ok
}

// Normalize once for policy checks and dialing, including IPv4-mapped IPv6.
func destination(authority, defaultPort string) (string, string, error) {
	h, port := strings.ToLower(authority), defaultPort
	if host, explicitPort, err := net.SplitHostPort(h); err == nil {
		h, port = host, explicitPort
		if port == "" {
			return "", "", errors.New("empty port")
		}
	} else if strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") {
		h = h[1 : len(h)-1]
	}
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", "", errors.New("invalid port")
		}
		port = strconv.Itoa(n)
	}
	h = strings.TrimSuffix(h, ".")
	if ip := net.ParseIP(h); ip != nil {
		return ip.String(), port, nil
	}
	if len(h) == 0 || len(h) > 253 {
		return "", "", errors.New("invalid hostname")
	}
	for _, label := range strings.Split(h, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", "", errors.New("invalid hostname label")
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return "", "", errors.New("invalid hostname character")
			}
		}
	}
	return h, port, nil
}

func policyDecision(p *Policy, host string) (allowed, audit bool, reason string) {
	if isIMDS(host) {
		return false, false, "imds-pin"
	}
	if p == nil {
		return false, false, "no-policy"
	}
	if p.Mode != "enforce" && p.Mode != "audit-only" {
		return false, false, "invalid-policy-mode"
	}
	if matchAllowlist(p.Allowlist, host) {
		return true, false, ""
	}
	if p.Mode == "audit-only" {
		return true, true, "not-in-allowlist"
	}
	return false, false, "not-in-allowlist"
}

var errMetadataAddress = errors.New("resolved destination is a metadata endpoint")

// Resolve exactly once; inspect every answer, then dial only validated IPs.
// This prevents DNS aliases and rebinding between validation and connection.
func dialResolved(ctx context.Context, host, port string,
	lookup func(context.Context, string) ([]net.IPAddr, error),
	dial func(context.Context, string, string) (net.Conn, error)) (net.Conn, error) {
	addresses, err := lookup(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(addresses) == 0 {
		return nil, errors.New("DNS returned no addresses")
	}
	for _, address := range addresses {
		if address.Zone != "" || address.IP == nil || isIMDS(address.IP.String()) {
			return nil, errMetadataAddress
		}
	}
	for _, address := range addresses {
		var conn net.Conn
		conn, err = dial(ctx, "tcp", net.JoinHostPort(address.IP.String(), port))
		if err == nil {
			return conn, nil
		}
	}
	return nil, err
}

// ─── Peek the first packet ─────────────────────────

// peekHostname reads one bounded ClientHello record or HTTP header, extracts a hostname, and
// returns (hostname, consumed_bytes, error).
//
// Detection order:
//  1. TLS ClientHello SNI (first byte 0x16, 0x17, 0x15, 0x14 = TLS record)
//  2. HTTP plaintext Host header
//  3. HTTP CONNECT <host:port>
//  4. Fallback: empty → caller decides (block unless in audit-only)
func peekHostname(r *bufio.Reader) (string, []byte, error) {
	peek, err := r.Peek(5)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", nil, err
	}

	// TLS ClientHello: record type 0x16, version 0x03xx
	if len(peek) >= 5 && peek[0] == 0x16 && peek[1] == 0x03 {
		recordLen := int(peek[3])<<8 | int(peek[4])
		if recordLen > 16384 {
			return "", nil, errors.New("tls record too large")
		}
		full, err := r.Peek(5 + recordLen)
		if err != nil {
			return "", nil, err
		}
		host := parseSNI(full)
		if host != "" {
			return host, nil, nil
		}
		return "", nil, errors.New("tls without SNI")
	}

	// HTTP plaintext: look for "GET ", "POST ", "HEAD ", "CONNECT " etc.
	if looksLikeHTTP(peek) {
		// Read only through the header terminator, not a fixed byte count (which
		// deadlocks short CONNECT requests waiting for the client's TLS data).
		header := make([]byte, 0, 1024)
		for len(header) < 16384 {
			b, err := r.ReadByte()
			if err != nil {
				return "", nil, err
			}
			header = append(header, b)
			if bytes.HasSuffix(header, []byte("\r\n\r\n")) {
				break
			}
		}
		if !bytes.HasSuffix(header, []byte("\r\n\r\n")) {
			return "", nil, errors.New("HTTP header too large")
		}
		host := parseHTTPHost(header)
		if host != "" {
			return host, header, nil
		}
		return "", nil, errors.New("http without Host header")
	}

	return "", nil, errors.New("unknown protocol")
}

func looksLikeHTTP(b []byte) bool {
	if len(b) < 4 {
		return false
	}
	for _, m := range []string{"GET ", "POST", "HEAD", "PUT ", "DELE", "CONN", "PATC", "OPTI"} {
		if bytes.HasPrefix(b, []byte(m)) {
			return true
		}
	}
	return false
}

func parseHTTPHost(b []byte) string {
	req, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(b)))
	if err != nil {
		return ""
	}
	return req.Host
}

// parseSNI extracts server_name from a (partial) TLS ClientHello.
// Returns "" if not present or parse fails.
func parseSNI(data []byte) string {
	// skip 5-byte record header
	if len(data) < 5+4 {
		return ""
	}
	body := data[5:]
	// handshake type (1 byte) + length (3 bytes)
	if len(body) < 4 || body[0] != 0x01 {
		return ""
	}
	// ClientHello: client_version (2) + random (32) + session_id_length (1) + session_id (var) + ...
	p := body[4:]
	if len(p) < 34 {
		return ""
	}
	p = p[34:]
	if len(p) < 1 {
		return ""
	}
	sessLen := int(p[0])
	p = p[1:]
	if len(p) < sessLen {
		return ""
	}
	p = p[sessLen:]
	// cipher_suites length (2) + cipher_suites
	if len(p) < 2 {
		return ""
	}
	csLen := int(p[0])<<8 | int(p[1])
	p = p[2:]
	if len(p) < csLen {
		return ""
	}
	p = p[csLen:]
	// compression_methods length (1) + compression_methods
	if len(p) < 1 {
		return ""
	}
	cmLen := int(p[0])
	p = p[1:]
	if len(p) < cmLen {
		return ""
	}
	p = p[cmLen:]
	// extensions length (2) + extensions
	if len(p) < 2 {
		return ""
	}
	extLen := int(p[0])<<8 | int(p[1])
	p = p[2:]
	if len(p) < extLen {
		return ""
	}
	ext := p[:extLen]
	// Walk extensions looking for type 0x00 (server_name)
	for len(ext) >= 4 {
		t := int(ext[0])<<8 | int(ext[1])
		l := int(ext[2])<<8 | int(ext[3])
		ext = ext[4:]
		if len(ext) < l {
			return ""
		}
		data := ext[:l]
		ext = ext[l:]
		if t != 0x00 {
			continue
		}
		// server_name_list length (2) + list
		if len(data) < 2 {
			return ""
		}
		// data[2] = type (0 = host_name)
		if len(data) < 5 {
			return ""
		}
		nameLen := int(data[3])<<8 | int(data[4])
		if len(data) < 5+nameLen {
			return ""
		}
		return string(data[5 : 5+nameLen])
	}
	return ""
}

// ─── Forwarding ────────────────────────────────────

// handleConn reads first packet, extracts hostname, checks allowlist, and
// forwards to the real destination if permitted.
func handleConn(ctx context.Context, client net.Conn, metrics *metrics) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(30 * time.Second))

	br := bufio.NewReaderSize(client, 32768)
	host, header, err := peekHostname(br)
	if err != nil {
		metrics.denied.Add(1)
		logDenied("unknown", 0, "protocol", err)
		return
	}

	connect := bytes.HasPrefix(header, []byte("CONNECT "))
	defaultPort := "443"
	if len(header) > 0 && !connect {
		defaultPort = "80"
	}
	host, port, err := destination(host, defaultPort)
	if err != nil {
		metrics.denied.Add(1)
		logDenied("invalid", 0, "invalid-destination", err)
		return
	}
	currentPolicy := policy.Load()
	allowed, audit, reason := policyDecision(currentPolicy, host)
	if currentPolicy != nil && currentPolicy.SchemaVersion == 2 {
		source, _, splitErr := net.SplitHostPort(client.RemoteAddr().String())
		if splitErr != nil {
			source = ""
		}
		lookupCtx, lookupCancel := context.WithTimeout(ctx, 4*time.Second)
		auth, lookupErr := resolveAuthorization(lookupCtx, resolverClient(envOr("DD_EGRESS_RESOLVER_SOCKET", "/etc/dd-egress/resolver.sock")), source)
		lookupCancel()
		if lookupErr != nil {
			allowed, audit, reason = false, false, "source-authorization-unavailable"
		} else {
			allowed, audit, reason = scopedDecision(auth, host)
		}
	}
	if !allowed {
		metrics.denied.Add(1)
		logDenied(host, port, reason, nil)
		if tcp, ok := client.(*net.TCPConn); ok {
			_ = tcp.SetLinger(0)
		}
		return
	}
	// Dial the real destination.
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var d net.Dialer
	upstream, err := dialResolved(dialCtx, host, port, net.DefaultResolver.LookupIPAddr, d.DialContext)
	if err != nil {
		if errors.Is(err, errMetadataAddress) {
			metrics.denied.Add(1)
			logDenied(host, port, "imds-pin", err)
			return
		}
		metrics.upstreamError.Add(1)
		logDenied(host, port, "upstream-dial-failed: "+err.Error(), nil)
		return
	}
	defer upstream.Close()
	_ = upstream.SetDeadline(time.Now().Add(30 * time.Second))
	if audit {
		metrics.auditOnly.Add(1)
		logDenied(host, port, reason+" (audit-only — not blocked)", nil)
	}
	metrics.allowed.Add(1)
	stop := context.AfterFunc(ctx, func() { _ = client.Close(); _ = upstream.Close() })
	defer stop()
	if connect {
		// CONNECT is consumed by this proxy; the target receives only tunnel data.
		if _, err := io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			return
		}
	} else if len(header) > 0 {
		if _, err := upstream.Write(header); err != nil {
			return
		}
	}

	// Replay the peeked buffer, then bidirectional copy.
	if buffered := br.Buffered(); buffered > 0 {
		peeked, _ := br.Peek(buffered)
		if _, werr := upstream.Write(peeked); werr != nil {
			return
		}
		_, _ = br.Discard(buffered)
	}
	_ = client.SetDeadline(time.Time{})
	_ = upstream.SetDeadline(time.Time{})

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, br)
		if tcp, ok := upstream.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		} else {
			_ = upstream.Close()
		}
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		if tcp, ok := client.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		} else {
			_ = client.Close()
		}
		done <- struct{}{}
	}()
	<-done
	<-done
}

// ─── Denied log ────────────────────────────────────

var (
	denyLogMu sync.Mutex
	denyLog   *os.File
)

func openDenyLog(path string) {
	denyLogMu.Lock()
	defer denyLogMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		log.Printf("denylog mkdir: %v", err)
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("denylog open: %v", err)
		return
	}
	denyLog = f
}

func logDenied(host, port interface{}, reason string, extraErr error) {
	line := fmt.Sprintf("%s host=%v port=%v reason=%s", time.Now().UTC().Format(time.RFC3339), host, port, reason)
	if extraErr != nil {
		line += " err=" + extraErr.Error()
	}
	line += "\n"
	log.Print(line) // stderr
	denyLogMu.Lock()
	defer denyLogMu.Unlock()
	if denyLog != nil {
		_, _ = denyLog.WriteString(line)
	}
}

// ─── Metrics ───────────────────────────────────────

type metrics struct {
	allowed       atomic.Uint64
	denied        atomic.Uint64
	auditOnly     atomic.Uint64
	upstreamError atomic.Uint64
	reloads       atomic.Uint64
}

func (m *metrics) serveMetrics(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		fmt.Fprintf(w, "dd_egress_connections_allowed_total %d\n", m.allowed.Load())
		fmt.Fprintf(w, "dd_egress_connections_blocked_total %d\n", m.denied.Load())
		fmt.Fprintf(w, "dd_egress_connections_audit_only_total %d\n", m.auditOnly.Load())
		fmt.Fprintf(w, "dd_egress_upstream_errors_total %d\n", m.upstreamError.Load())
		fmt.Fprintf(w, "dd_egress_policy_reloads_total %d\n", m.reloads.Load())
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		p := policy.Load()
		if p == nil {
			http.Error(w, "no policy loaded", http.StatusServiceUnavailable)
			return
		}
		fmt.Fprintf(w, "ok policy_v%d allowlist=%d mode=%s", p.Version, len(p.Allowlist), p.Mode)
	})
	log.Printf("metrics server: %s", addr)
	_ = http.ListenAndServe(addr, mux)
}

// ─── Main ──────────────────────────────────────────

func main() {
	cfg := loadCfg()
	log.SetOutput(os.Stderr)
	log.Printf("dd-egress-proxy starting: listen=%s policy=%s", cfg.addr, cfg.policyPath)

	m := &metrics{}

	// Initial policy load (fail fast — refuse to start without policy)
	p, err := loadPolicy(cfg.policyPath)
	if err != nil {
		log.Fatalf("initial policy load failed: %v", err)
	}
	policy.Store(p)
	log.Printf("loaded policy v%d mode=%s allowlist=%d", p.Version, p.Mode, len(p.Allowlist))

	openDenyLog(cfg.blockLogPath)

	// SIGHUP handler
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
			np, err := loadPolicy(cfg.policyPath)
			if err != nil {
				log.Printf("reload failed, keeping old policy: %v", err)
				continue
			}
			policy.Store(np)
			m.reloads.Add(1)
			log.Printf("reloaded policy v%d mode=%s allowlist=%d", np.Version, np.Mode, len(np.Allowlist))
		}
	}()

	// Graceful shutdown on INT/TERM
	ctx, cancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("shutdown signal received")
		cancel()
	}()

	// Optional metrics endpoint
	if cfg.metricsAddr != "" {
		go m.serveMetrics(cfg.metricsAddr)
	}

	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("accepting connections on %s", cfg.addr)

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				log.Println("listener closed, exiting")
				return
			default:
				log.Printf("accept: %v", err)
				continue
			}
		}
		go handleConn(ctx, conn, m)
	}
}
