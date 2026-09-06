// gateway/dashboard_test.go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDashboardSessionsAPI(t *testing.T) {
	reg := NewRegistry(30 * time.Second)
	reg.Register("user1", "sess1", "http://10.0.0.1:4096", "/proj-a")
	reg.Register("user1", "sess2", "http://10.0.0.1:4097", "/proj-b")
	reg.Register("user2", "sess3", "http://10.0.0.2:4096", "/proj-c")

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
