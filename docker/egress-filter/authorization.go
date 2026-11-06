package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

type scopedPolicy struct {
	ID        int      `json:"id"`
	Mode      string   `json:"mode"`
	Allowlist []string `json:"allowlist"`
}

type sourceAuthorization struct {
	Source      string         `json:"source"`
	ContainerID string         `json:"containerId"`
	Policies    []scopedPolicy `json:"policies"`
}

var containerIDPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func resolverClient(socketPath string) *http.Client {
	return &http.Client{
		Timeout:       4 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("resolver redirects forbidden") },
		Transport: &http.Transport{
			DisableKeepAlives:      true,
			MaxResponseHeaderBytes: 4096,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var dialer net.Dialer
				return dialer.DialContext(ctx, "unix", socketPath)
			},
		},
	}
}

func resolveAuthorization(ctx context.Context, client *http.Client, source string) (*sourceAuthorization, error) {
	ip := net.ParseIP(source)
	if ip == nil {
		return nil, errors.New("invalid source")
	}
	source = ip.String()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://local/resolve?source="+url.QueryEscape(source), nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("source not authorized")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(data) > 65536 {
		return nil, errors.New("invalid authorization size")
	}
	var auth sourceAuthorization
	if err := json.Unmarshal(data, &auth); err != nil {
		return nil, err
	}
	if auth.Source != source || !containerIDPattern.MatchString(auth.ContainerID) || len(auth.Policies) == 0 || len(auth.Policies) > 100 {
		return nil, errors.New("invalid authorization identity")
	}
	seen := map[int]bool{}
	for index := range auth.Policies {
		p := &auth.Policies[index]
		if p.ID < 1 || seen[p.ID] || (p.Mode != "enforce" && p.Mode != "audit-only") || len(p.Allowlist) > 1000 {
			return nil, errors.New("invalid scoped policy")
		}
		seen[p.ID] = true
		validated := Policy{Mode: p.Mode, Allowlist: p.Allowlist}
		if err := normalizePolicy(&validated); err != nil {
			return nil, err
		}
		p.Allowlist = validated.Allowlist
	}
	return &auth, nil
}

func scopedDecision(auth *sourceAuthorization, host string) (bool, bool, string) {
	if auth == nil || len(auth.Policies) == 0 {
		return false, false, "no-source-policy"
	}
	audited := false
	for _, scoped := range auth.Policies {
		allowed, audit, reason := policyDecision(&Policy{Mode: scoped.Mode, Allowlist: scoped.Allowlist}, host)
		if !allowed {
			return false, false, reason
		}
		audited = audited || audit
	}
	if audited {
		return true, true, "not-in-allowlist"
	}
	return true, false, ""
}
