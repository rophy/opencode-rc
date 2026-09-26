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
	req.Header.Set(ProtocolHeader, "1")
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
	req.Header.Set(ProtocolHeader, "1")
	req.Header.Set("Authorization", "Bearer bad-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestTunnelHandlerUpgradeFailure(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&mockVerifier{claims: `{"email":"user@example.com","sub":"user1"}`}, nil, reg, "10.0.0.1:9090")

	// Send a normal HTTP request (not WebSocket) — upgrader.Upgrade will fail
	req := httptest.NewRequest("GET", "/tunnel?sessionId=s1&directory=/proj", nil)
	req.Header.Set(ProtocolHeader, "1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	// Upgrade fails because the request lacks proper WS upgrade headers
	// The handler logs the error and returns without writing a response
	// (gorilla upgrader writes a 400 Bad Request)
	if rec.Code == http.StatusOK {
		t.Error("expected non-200 for non-WebSocket request to tunnel handler")
	}
}

func TestTunnelHandlerClaimsError(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&badClaimsVerifier{}, nil, reg, "10.0.0.1:9090")

	req := httptest.NewRequest("GET", "/tunnel?sessionId=s1", nil)
	req.Header.Set(ProtocolHeader, "1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}
}

func TestTunnelHandlerMissingSessionId(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&mockVerifier{claims: `{"email":"user@example.com","sub":"user1"}`}, nil, reg, "10.0.0.1:9090")

	req := httptest.NewRequest("GET", "/tunnel", nil)
	req.Header.Set(ProtocolHeader, "1")
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestTunnelHandlerCLIVerifierFallback(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)

	primary := &mockVerifier{err: errors.New("wrong audience")}
	cli := &mockVerifier{claims: `{"email":"cliuser@example.com","sub":"sub2"}`}
	handler := TunnelHandler(primary, cli, reg, "10.0.0.1:9090")

	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "?sessionId=cli-sess&directory=/proj"
	header := http.Header{"Authorization": []string{"Bearer cli-token"}, ProtocolHeader: []string{"1"}}
	ws, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	if resp != nil {
		defer resp.Body.Close()
	}
	defer ws.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if m, ok := reg.GetMeta(t.Context(), "cli-sess"); ok {
			if m.UserID != "cliuser@example.com" {
				t.Errorf("expected cliuser@example.com, got %s", m.UserID)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("expected session to be registered via CLI verifier")
}

func TestTunnelHandlerSubFallback(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&mockVerifier{claims: `{"email":"","sub":"sub-only-user"}`}, nil, reg, "10.0.0.1:9090")

	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "?sessionId=sub-sess&directory=/proj"
	header := http.Header{"Authorization": []string{"Bearer valid-token"}, ProtocolHeader: []string{"1"}}
	ws, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	if resp != nil {
		defer resp.Body.Close()
	}
	defer ws.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if m, ok := reg.GetMeta(t.Context(), "sub-sess"); ok {
			if m.UserID != "sub-only-user" {
				t.Errorf("expected sub-only-user, got %s", m.UserID)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("expected session to be registered with sub fallback")
}

func TestTunnelHandlerSuccess(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelHandler(&mockVerifier{claims: `{"email":"user@example.com","sub":"user1"}`}, nil, reg, "10.0.0.1:9090")

	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "?sessionId=test-sess&directory=/proj"
	header := http.Header{"Authorization": []string{"Bearer valid-token"}, ProtocolHeader: []string{"1"}}
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
	if meta.GatewayAddr != "10.0.0.1:9090" {
		t.Errorf("expected 10.0.0.1:9090, got %s", meta.GatewayAddr)
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
