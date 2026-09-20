package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestScopedPolicyIntersection(t *testing.T) {
	container := scopedPolicy{ID: 1, Mode: "enforce", Allowlist: []string{"container.example", "common.example"}}
	stack := scopedPolicy{ID: 2, Mode: "enforce", Allowlist: []string{"stack.example", "common.example"}}
	auth := &sourceAuthorization{Policies: []scopedPolicy{container, stack}}
	for host, want := range map[string]bool{"common.example": true, "container.example": false, "stack.example": false, "unrelated.example": false, "169.254.169.254": false} {
		if allowed, _, _ := scopedDecision(auth, host); allowed != want {
			t.Errorf("%s allowed=%v want=%v", host, allowed, want)
		}
	}
	auth.Policies[1].Mode = "audit-only"
	if allowed, audit, _ := scopedDecision(auth, "container.example"); !allowed || !audit {
		t.Fatal("expected allowed audit event")
	}
	if allowed, _, _ := scopedDecision(auth, "stack.example"); allowed {
		t.Fatal("audit policy overrode enforce policy")
	}
	if allowed, _, _ := scopedDecision(nil, "common.example"); allowed {
		t.Fatal("missing source policy permitted traffic")
	}
}

func TestUnixAuthorizationProtocol(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix socket transport is verified on Linux, the sidecar deployment platform")
	}
	// This is the real Unix-socket transport used in Linux containers. There is
	// no TCP listener and no public application API exposing authorization.
	socket := filepath.Join(t.TempDir(), "a.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var responseBody string
	var responseCode = http.StatusOK
	type reply struct {
		code int
		body string
	}
	var response atomic.Value
	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet || req.URL.Path != "/resolve" || req.URL.Query().Get("source") != "172.20.0.4" {
			t.Error("unexpected authorization request")
		}
		current := response.Load().(reply)
		w.WriteHeader(current.code)
		_, _ = io.WriteString(w, current.body)
	})
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	client := resolverClient(socket)
	valid := sourceAuthorization{Source: "172.20.0.4", ContainerID: strings.Repeat("a", 64),
		Policies: []scopedPolicy{{ID: 1, Mode: "enforce", Allowlist: []string{"*.Example.COM."}}}}
	encoded, _ := json.Marshal(valid)
	responseBody = string(encoded)
	response.Store(reply{responseCode, responseBody})
	auth, err := resolveAuthorization(context.Background(), client, "172.20.0.4")
	if err != nil || auth.Policies[0].Allowlist[0] != "*.example.com" {
		t.Fatalf("%+v %v", auth, err)
	}
	for name, mutate := range map[string]func(*sourceAuthorization){
		"wrong source":     func(a *sourceAuthorization) { a.Source = "172.20.0.5" },
		"wrong ID":         func(a *sourceAuthorization) { a.ContainerID = "short" },
		"no policies":      func(a *sourceAuthorization) { a.Policies = nil },
		"invalid mode":     func(a *sourceAuthorization) { a.Policies[0].Mode = "typo" },
		"invalid hostname": func(a *sourceAuthorization) { a.Policies[0].Allowlist = []string{"*"} },
		"duplicate policy": func(a *sourceAuthorization) { a.Policies = append(a.Policies, a.Policies[0]) },
	} {
		t.Run(name, func(t *testing.T) {
			var candidate sourceAuthorization
			_ = json.Unmarshal(encoded, &candidate)
			mutate(&candidate)
			body, _ := json.Marshal(candidate)
			responseBody = string(body)
			response.Store(reply{responseCode, responseBody})
			if _, err := resolveAuthorization(context.Background(), client, "172.20.0.4"); err == nil {
				t.Fatal("invalid response accepted")
			}
		})
	}
	for _, body := range []string{"not JSON", strings.Repeat("x", 65537), string(encoded) + " {}"} {
		responseBody = body
		response.Store(reply{responseCode, responseBody})
		if _, err := resolveAuthorization(context.Background(), client, "172.20.0.4"); err == nil {
			t.Fatal("malformed/oversized response accepted")
		}
	}
	responseCode, responseBody = http.StatusForbidden, string(encoded)
	response.Store(reply{responseCode, responseBody})
	if _, err := resolveAuthorization(context.Background(), client, "172.20.0.4"); err == nil {
		t.Fatal("denied source accepted")
	}
	server.Close()
	if _, err := resolveAuthorization(context.Background(), client, "172.20.0.4"); err == nil {
		t.Fatal("missing resolver allowed")
	}
}

func TestAuthorizationDeadline(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix socket transport is verified on Linux, the sidecar deployment platform")
	}
	socket := filepath.Join(t.TempDir(), "a.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) { <-req.Context().Done() })}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := resolveAuthorization(ctx, resolverClient(socket), "172.20.0.4"); err == nil {
		t.Fatal("authorization deadline ignored")
	}
}
