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
	if !strings.Contains(log, "level=INFO") {
		t.Errorf("expected level=INFO in log, got: %s", log)
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

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}

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

func TestValidateEndpointRejectsLoopback(t *testing.T) {
	if err := validateEndpoint("http://127.0.0.1:4096"); err == nil {
		t.Error("expected error for loopback address")
	}
}

func TestValidateEndpointRejectsMetadata(t *testing.T) {
	if err := validateEndpoint("http://169.254.169.254/latest"); err == nil {
		t.Error("expected error for metadata address")
	}
}

func TestValidateEndpointAcceptsPrivateIP(t *testing.T) {
	if err := validateEndpoint("http://10.0.0.5:4096"); err != nil {
		t.Errorf("expected no error for private IP, got: %v", err)
	}
}
