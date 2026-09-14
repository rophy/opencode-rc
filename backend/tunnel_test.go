package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestTunnelHandlerMissingAuth(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&mockVerifier{}, nil, reg, "10.0.0.1:9090")

	req := httptest.NewRequest("GET", "/tunnel?sessionId=s1", nil)
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestTunnelHandlerInvalidToken(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&mockVerifier{err: errors.New("invalid signature")}, nil, reg, "10.0.0.1:9090")

	req := httptest.NewRequest("GET", "/tunnel?sessionId=s1", nil)
	req.Header.Set("Authorization", "Bearer bad-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestTunnelHandlerMissingSessionId(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&mockVerifier{claims: `{"email":"user@example.com","sub":"user1"}`}, nil, reg, "10.0.0.1:9090")

	req := httptest.NewRequest("GET", "/tunnel", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestTunnelHandlerSuccess(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&mockVerifier{claims: `{"email":"user@example.com","sub":"user1"}`}, nil, reg, "10.0.0.1:9090")

	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "?sessionId=test-sess&directory=/proj"
	header := http.Header{"Authorization": []string{"Bearer valid-token"}}
	ws, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	if resp != nil {
		defer resp.Body.Close()
	}
	defer ws.Close()

	var meta SessionMeta
	var found bool
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if m, ok := reg.GetMeta(t.Context(), "test-sess"); ok {
			meta = m
			found = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !found {
		t.Fatal("expected session to be registered")
	}
	if meta.UserID != "user@example.com" {
		t.Errorf("expected user@example.com, got %s", meta.UserID)
	}
	if meta.Directory != "/proj" {
		t.Errorf("expected /proj, got %s", meta.Directory)
	}
	if meta.TunnelerAddr != "10.0.0.1:9090" {
		t.Errorf("expected 10.0.0.1:9090, got %s", meta.TunnelerAddr)
	}

	if _, ok := reg.GetTunnel("test-sess"); !ok {
		t.Fatal("expected tunnel to be registered")
	}

	ws.Close()

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := reg.GetTunnel("test-sess"); !ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("expected session to be deregistered after tunnel close")
}
