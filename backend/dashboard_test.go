// gateway/dashboard_test.go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDashboardSessionsAPI(t *testing.T) {
	reg := NewRegistry()
	reg.RegisterTunnel("user1", "sess1", "/proj-a", nil)
	reg.RegisterTunnel("user1", "sess2", "/proj-b", nil)
	reg.RegisterTunnel("user2", "sess3", "/proj-c", nil)

	handler := DashboardSessionsHandler(reg)

	req := httptest.NewRequest("GET", "/gateway/sessions", nil)
	ctx := setUserContext(req.Context(), "user1")
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var sessions []Session
	if err := json.NewDecoder(rec.Body).Decode(&sessions); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if len(sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(sessions))
	}
}

func TestDashboardSessionsUnauthorized(t *testing.T) {
	reg := NewRegistry()
	handler := DashboardSessionsHandler(reg)

	req := httptest.NewRequest("GET", "/gateway/sessions", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestDashboardSessionsEmpty(t *testing.T) {
	reg := NewRegistry()
	handler := DashboardSessionsHandler(reg)

	req := httptest.NewRequest("GET", "/gateway/sessions", nil)
	ctx := setUserContext(req.Context(), "user1")
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Errorf("expected empty array, got: %s", rec.Body.String())
	}
}

func TestDashboardHandler(t *testing.T) {
	handler := DashboardHandler()

	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "text/html") {
		t.Errorf("expected text/html content type, got %s", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "opencode-rc") {
		t.Errorf("expected body to contain opencode-rc, got: %s", rec.Body.String())
	}
}
