package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPolicyValidation(t *testing.T) {
	for _, input := range []string{
		`{"mode":"typo"}`, `{"mode":"ENFORCE"}`, `{"mode":"enforce"} {}`,
		`{"allowlist":["*"]}`, `{"allowlist":["allowed.example/evil"]}`,
		`{"allowlist":["allowed.example:443"]}`, `{"allowlist":["a..example"]}`,
		strings.Repeat(" ", 65537),
	} {
		t.Run(fmt.Sprintf("invalid-%d", len(input))+input[:min(len(input), 20)], func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "policy.json")
			if err := os.WriteFile(file, []byte(input), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadPolicy(file); err == nil {
				t.Fatalf("accepted invalid policy %q", input[:min(len(input), 80)])
			}
		})
	}
	file := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(file, []byte(`{"version":1,"allowlist":[" *.Example.COM. "]}`), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := loadPolicy(file)
	if err != nil || p.Mode != "enforce" || p.Allowlist[0] != "*.example.com" {
		t.Fatalf("policy=%+v error=%v", p, err)
	}
}

func TestIMDSCannotBeOverridden(t *testing.T) {
	for _, mode := range []string{"enforce", "audit-only", "typo"} {
		for _, host := range []string{"169.254.169.254", "169.254.170.2:80", "METADATA.GOOGLE.INTERNAL.", "[::ffff:169.254.169.254]:80", "[fd00:ec2::254]:80"} {
			t.Run(mode+"/"+host, func(t *testing.T) {
				allowed, audit, reason := policyDecision(&Policy{Mode: mode, Allowlist: []string{host, "*.google.internal"}}, host)
				if allowed || audit || reason != "imds-pin" {
					t.Fatalf("metadata bypass: %v %v %s", allowed, audit, reason)
				}
			})
		}
	}
	for _, p := range []*Policy{nil, {Mode: "typo", Allowlist: []string{"allowed.example"}}} {
		if allowed, _, _ := policyDecision(p, "allowed.example"); allowed {
			t.Fatal("missing/invalid policy permitted traffic")
		}
	}
	if allowed, audit, _ := policyDecision(&Policy{Mode: "audit-only"}, "allowed.example"); !allowed || !audit {
		t.Fatal("audit-only did not permit and record ordinary traffic")
	}
	if allowed, _, _ := policyDecision(&Policy{Mode: "enforce"}, "allowed.example"); allowed {
		t.Fatal("enforce permitted unlisted traffic")
	}
}

func TestAllowlistBoundaries(t *testing.T) {
	for host, expected := range map[string]bool{
		"example.com": true, "a.example.com": true, "A.B.EXAMPLE.COM.:443": true,
		"evilexample.com": false, "example.com.evil": false, "a..example.com": false,
		"example.com@evil": false, "example.com:evil": false, "example.com\n": false,
	} {
		if result := matchAllowlist([]string{"*.example.com"}, host); result != expected {
			t.Errorf("%q = %v, want %v", host, result, expected)
		}
	}
}

func TestDestinationPortsAndIPv6(t *testing.T) {
	for _, input := range []string{"example.com:", "example.com:0", "example.com:65536", "user@example.com", "[::1%eth0]:443"} {
		if _, _, err := destination(input, "443"); err == nil {
			t.Errorf("accepted %q", input)
		}
	}
	host, port, err := destination("[2001:db8::1]:8443", "443")
	if err != nil || host != "2001:db8::1" || port != "8443" {
		t.Fatalf("%s %s %v", host, port, err)
	}
}

func TestDNSMetadataAliasesNeverDial(t *testing.T) {
	for _, blocked := range []string{"169.254.169.254", "::ffff:169.254.170.2", "fd00:ec2::254"} {
		lookup := func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("192.0.2.1")}, {IP: net.ParseIP(blocked)}}, nil
		}
		_, err := dialResolved(context.Background(), "allowed.example", "443", lookup,
			func(context.Context, string, string) (net.Conn, error) {
				t.Fatal("dial reached before checking all DNS answers")
				return nil, nil
			})
		if !errors.Is(err, errMetadataAddress) {
			t.Fatalf("%s: %v", blocked, err)
		}
	}
}

func TestDNSResolutionPinnedOnce(t *testing.T) {
	lookups := 0
	lookup := func(context.Context, string) ([]net.IPAddr, error) {
		lookups++
		return []net.IPAddr{{IP: net.ParseIP("192.0.2.1")}, {IP: net.ParseIP("2001:db8::2")}}, nil
	}
	var targets []string
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	conn, err := dialResolved(context.Background(), "allowed.example", "443", lookup,
		func(_ context.Context, network, target string) (net.Conn, error) {
			targets = append(targets, target)
			if network != "tcp" {
				t.Fatal(network)
			}
			if len(targets) == 1 {
				return nil, errors.New("try next validated address")
			}
			return left, nil
		})
	if err != nil || conn != left || lookups != 1 || strings.Join(targets, ",") != "192.0.2.1:443,[2001:db8::2]:443" {
		t.Fatalf("%v %d %v", err, lookups, targets)
	}
}

func TestHTTPHeaderCompletesWithoutWaitingForBody(t *testing.T) {
	for _, header := range []string{
		"GET / HTTP/1.1\r\nHost: allowed.example\r\n\r\n",
		"CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n",
	} {
		left, right := net.Pipe()
		_ = left.SetReadDeadline(time.Now().Add(time.Second))
		go func() { _, _ = io.WriteString(right, header) }()
		host, consumed, err := peekHostname(bufio.NewReaderSize(left, 32768))
		left.Close()
		right.Close()
		if err != nil || host == "" || string(consumed) != header {
			t.Fatalf("host=%q header=%q error=%v", host, consumed, err)
		}
	}
	for _, header := range []string{
		"GET / HTTP/1.1\r\nHost: allowed.example\r\nHost: other.example\r\n\r\n",
		"GET / HTTP/1.1\r\nX-Large: " + strings.Repeat("x", 16384) + "\r\n\r\n",
		"CONNECT allowed.example:443 HTTP/1.1\r\n", // truncated header
	} {
		if _, _, err := peekHostname(bufio.NewReaderSize(strings.NewReader(header), 32768)); err == nil {
			t.Fatal("accepted malformed header")
		}
	}
}

func TestRealTLSClientHelloAndTruncations(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	_ = left.SetReadDeadline(time.Now().Add(2 * time.Second))
	go func() {
		_ = tls.Client(right, &tls.Config{ServerName: "allowed.example", MinVersion: tls.VersionTLS12}).Handshake()
	}()
	reader := bufio.NewReaderSize(left, 32768)
	host, consumed, err := peekHostname(reader)
	if err != nil || host != "allowed.example" || len(consumed) != 0 {
		t.Fatalf("%q %v", host, err)
	}
	header, _ := reader.Peek(5)
	record, _ := reader.Peek(5 + int(header[3])<<8 + int(header[4]))
	for n := 0; n < len(record); n++ {
		_ = parseSNI(record[:n])
	} // every truncation must remain panic-free
}

func TestProxyHTTPAndConnect(t *testing.T) {
	previous := policy.Load()
	defer policy.Store(previous)
	policy.Store(&Policy{Mode: "enforce", Allowlist: []string{"127.0.0.1"}})
	for _, connect := range []bool{false, true} {
		t.Run(fmt.Sprintf("CONNECT=%v", connect), func(t *testing.T) {
			upstream, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer upstream.Close()
			upstreamResult := make(chan string, 1)
			go func() {
				conn, err := upstream.Accept()
				if err != nil {
					upstreamResult <- err.Error()
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				if connect {
					body, err := io.ReadAll(conn)
					if err != nil {
						upstreamResult <- err.Error()
						return
					}
					upstreamResult <- string(body)
					_, _ = io.WriteString(conn, "pong")
				} else {
					reader := bufio.NewReader(conn)
					var header strings.Builder
					for {
						line, err := reader.ReadString('\n')
						if err != nil {
							upstreamResult <- err.Error()
							return
						}
						header.WriteString(line)
						if line == "\r\n" {
							break
						}
					}
					upstreamResult <- header.String()
					_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
				}
			}()
			proxy, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer proxy.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			done := make(chan struct{})
			go func() {
				defer close(done)
				conn, err := proxy.Accept()
				if err == nil {
					handleConn(ctx, conn, &metrics{})
				}
			}()
			client, err := net.Dial("tcp", proxy.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(3 * time.Second))
			if connect {
				_, _ = fmt.Fprintf(client, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\nping", upstream.Addr(), upstream.Addr())
				reader := bufio.NewReader(client)
				line, err := reader.ReadString('\n')
				if err != nil || line != "HTTP/1.1 200 Connection Established\r\n" {
					t.Fatalf("CONNECT: %q %v", line, err)
				}
				_, _ = reader.ReadString('\n')
				_ = client.(*net.TCPConn).CloseWrite()
				body, err := io.ReadAll(reader)
				if err != nil || string(body) != "pong" {
					t.Fatalf("response after half-close: %q %v", body, err)
				}
				if got := <-upstreamResult; got != "ping" {
					t.Fatalf("CONNECT header leaked to target: %q", got)
				}
			} else {
				header := fmt.Sprintf("GET /hello HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", upstream.Addr())
				_, _ = io.WriteString(client, header)
				_ = client.(*net.TCPConn).CloseWrite()
				response, err := io.ReadAll(client)
				if err != nil || !strings.HasSuffix(string(response), "\r\n\r\nOK") {
					t.Fatalf("HTTP: %q %v", response, err)
				}
				if got := <-upstreamResult; got != header {
					t.Fatalf("HTTP header replay changed: %q", got)
				}
			}
			<-done
		})
	}
}

func FuzzSNI(f *testing.F) {
	f.Add([]byte{0x16, 0x03, 0x03, 0, 4, 1, 0, 0, 0})
	f.Add([]byte{})
	f.Fuzz(func(_ *testing.T, data []byte) { _ = parseSNI(data) })
}
