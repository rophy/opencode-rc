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
	auth := testAuthWithVerifier(&mockVerifier{}, nil)
	reg := NewRegistry()
	handler := TunnelHandler(auth, reg)

	req := httptest.NewRequest("GET", "/tunnel?sessionId=s1", nil)
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestTunnelHandlerInvalidToken(t *testing.T) {
	auth := testAuthWithVerifier(&mockVerifier{err: errors.New("invalid signature")}, nil)
	reg := NewRegistry()
	handler := TunnelHandler(auth, reg)

	req := httptest.NewRequest("GET", "/tunnel?sessionId=s1", nil)
	req.Header.Set("Authorization", "Bearer bad-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestTunnelHandlerMissingSessionId(t *testing.T) {
	auth := testAuthWithVerifier(&mockVerifier{claims: `{"email":"user@example.com","sub":"user1"}`}, nil)
	reg := NewRegistry()
	handler := TunnelHandler(auth, reg)

	req := httptest.NewRequest("GET", "/tunnel", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestTunnelHandlerSuccess(t *testing.T) {
	auth := testAuthWithVerifier(&mockVerifier{claims: `{"email":"user@example.com","sub":"user1"}`}, nil)
	reg := NewRegistry()
	handler := TunnelHandler(auth, reg)

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

	var sess *Session
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s, ok := reg.Lookup("test-sess"); ok {
			sess = s
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if sess == nil {
		t.Fatal("expected session to be registered")
	}
	if sess.UserID != "user@example.com" {
		t.Errorf("expected user@example.com, got %s", sess.UserID)
	}
	if sess.Directory != "/proj" {
		t.Errorf("expected /proj, got %s", sess.Directory)
	}

	ws.Close()

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := reg.Lookup("test-sess"); !ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("expected session to be deregistered after tunnel close")
}
