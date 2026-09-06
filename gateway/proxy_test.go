package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProxyRegularHTTP(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/session" {
			t.Errorf("expected /api/session, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"sessions":[]}`))
	}))
	defer backend.Close()

	reg := NewRegistry(30 * time.Second)
	reg.Register("user1", "sess1", backend.URL, "/proj")

	handler := ProxyHandler(reg)
	req := httptest.NewRequest("GET", "/s/sess1/api/session", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "sessions") {
		t.Errorf("unexpected body: %s", rec.Body.String())
	}
}

func TestProxySSEStreaming(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("expected flusher")
		}
		for i := 0; i < 3; i++ {
			w.Write([]byte("event: message\ndata: {\"i\":" + strings.Repeat("0", i) + "}\n\n"))
			flusher.Flush()
		}
	}))
	defer backend.Close()

	reg := NewRegistry(30 * time.Second)
	reg.Register("user1", "sess1", backend.URL, "/proj")

	handler := ProxyHandler(reg)
	req := httptest.NewRequest("GET", "/s/sess1/api/event", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Header().Get("Content-Type") != "text/event-stream" {
		t.Errorf("expected text/event-stream, got %s", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "event: message") {
		t.Errorf("expected SSE events, got: %s", rec.Body.String())
	}
}

func TestProxySessionNotFound(t *testing.T) {
	reg := NewRegistry(30 * time.Second)
	handler := ProxyHandler(reg)

	req := httptest.NewRequest("GET", "/s/nonexistent/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
}

func TestProxyAddsDirectoryHeader(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dir := r.Header.Get("X-Opencode-Directory")
		if dir != "/home/user1/project" {
			t.Errorf("expected X-Opencode-Directory=/home/user1/project, got %s", dir)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	reg := NewRegistry(30 * time.Second)
	reg.Register("user1", "sess1", backend.URL, "/home/user1/project")

	handler := ProxyHandler(reg)
	req := httptest.NewRequest("GET", "/s/sess1/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}
