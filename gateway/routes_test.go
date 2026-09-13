package main

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestLoggerStatus200(t *testing.T) {
	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))

	handler := requestLogger(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))

	req := httptest.NewRequest("GET", "/healthz", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	log := buf.String()
	if !strings.Contains(log, "method=GET") {
		t.Errorf("expected method=GET in log, got: %s", log)
	}
	if !strings.Contains(log, "path=/healthz") {
		t.Errorf("expected path=/healthz in log, got: %s", log)
	}
	if !strings.Contains(log, "status=200") {
		t.Errorf("expected status=200 in log, got: %s", log)
	}
}

func TestRequestLoggerStatus404(t *testing.T) {
	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))

	handler := requestLogger(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))

	req := httptest.NewRequest("GET", "/missing", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	log := buf.String()
	if !strings.Contains(log, "status=404") {
		t.Errorf("expected status=404 in log, got: %s", log)
	}
}

func TestRequestLoggerStatus500(t *testing.T) {
	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))

	handler := requestLogger(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))

	req := httptest.NewRequest("POST", "/api/broken", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	log := buf.String()
	if !strings.Contains(log, "method=POST") {
		t.Errorf("expected method=POST in log, got: %s", log)
	}
	if !strings.Contains(log, "status=500") {
		t.Errorf("expected status=500 in log, got: %s", log)
	}
}

func TestRequestLoggerIncludesDuration(t *testing.T) {
	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))

	handler := requestLogger(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	log := buf.String()
	if !strings.Contains(log, "duration=") {
		t.Errorf("expected duration in log, got: %s", log)
	}
}

func TestMarshalJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	marshalJSON(rec, http.StatusCreated, map[string]string{"status": "ok"})

	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected application/json, got %s", ct)
	}
	if !strings.Contains(rec.Body.String(), `"status":"ok"`) {
		t.Errorf("unexpected body: %s", rec.Body.String())
	}
}

func TestIsWebSocketUpgrade(t *testing.T) {
	req := httptest.NewRequest("GET", "/s/sess1/ws", nil)
	req.Header.Set("Upgrade", "websocket")
	if !isWebSocketUpgrade(req) {
		t.Error("expected true for websocket upgrade header")
	}

	req2 := httptest.NewRequest("GET", "/s/sess1/api/session", nil)
	if isWebSocketUpgrade(req2) {
		t.Error("expected false when no Upgrade header")
	}

	req3 := httptest.NewRequest("GET", "/s/sess1/api/session", nil)
	req3.Header.Set("Upgrade", "other")
	if isWebSocketUpgrade(req3) {
		t.Error("expected false for non-websocket Upgrade header")
	}
}
