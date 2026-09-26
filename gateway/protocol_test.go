package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadProtocol(t *testing.T) {
	cases := map[string]int{"3": 3, "": 0, "abc": 0, "-1": 0, "1.5": 0, "2x": 0}
	for in, want := range cases {
		if got := readProtocol(in); got != want {
			t.Errorf("readProtocol(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestCheckCLIProtocolWithoutHeader(t *testing.T) {
	w := httptest.NewRecorder()
	if checkCLIProtocol(w, httptest.NewRequest("GET", "/tunnel", nil)) {
		t.Fatal("expected rejection")
	}
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	want := "opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest"
	if strings.TrimSpace(w.Body.String()) != want {
		t.Fatalf("body = %q", w.Body.String())
	}
}

func TestCheckCLIProtocolTooLow(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/tunnel", nil)
	r.Header.Set(ProtocolHeader, "0")
	if checkCLIProtocol(w, r) {
		t.Fatal("expected rejection")
	}
	if w.Code != http.StatusUpgradeRequired {
		t.Fatalf("status = %d, want 426", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "client_outdated" || body["client"] != float64(0) || body["minimum"] != float64(1) || body["server"] != float64(1) {
		t.Fatalf("body = %v", body)
	}
}

func TestCheckCLIProtocolCurrent(t *testing.T) {
	r := httptest.NewRequest("GET", "/tunnel", nil)
	r.Header.Set(ProtocolHeader, "1")
	if !checkCLIProtocol(httptest.NewRecorder(), r) {
		t.Fatal("expected acceptance")
	}
}

func TestWithProtocolHeader(t *testing.T) {
	h := withProtocolHeader(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if w.Header().Get(ProtocolHeader) != "1" {
		t.Fatalf("header = %q", w.Header().Get(ProtocolHeader))
	}
}

func TestTunnelChecksProtocolBeforeAuth(t *testing.T) {
	h := TunnelHandler(nil, nil, nil, "pod:9090")
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", "/tunnel?sessionId=s", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (protocol) before 401 (auth)", w.Code)
	}
}
