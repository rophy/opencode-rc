// gateway/dashboard_test.go
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDashboardSessionsAPI(t *testing.T) {
	store := testRedisStore(t)
	ctx := context.Background()
	store.Put(ctx, SessionMeta{ID: "sess1", UserID: "user1", Directory: "/proj-a"})
	store.Put(ctx, SessionMeta{ID: "sess2", UserID: "user1", Directory: "/proj-b"})
	store.Put(ctx, SessionMeta{ID: "sess3", UserID: "user2", Directory: "/proj-c"})

	handler := DashboardSessionsHandler(store)

	req := httptest.NewRequest("GET", "/gateway/sessions", nil)
	reqCtx := setUserContext(req.Context(), "user1")
	req = req.WithContext(reqCtx)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var sessions []SessionMeta
	if err := json.NewDecoder(rec.Body).Decode(&sessions); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if len(sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(sessions))
	}
}

func TestDashboardSessionsUnauthorized(t *testing.T) {
	store := testRedisStore(t)
	handler := DashboardSessionsHandler(store)

	req := httptest.NewRequest("GET", "/gateway/sessions", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestDashboardSessionsEmpty(t *testing.T) {
	store := testRedisStore(t)
	handler := DashboardSessionsHandler(store)

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
