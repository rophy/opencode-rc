package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayProxyReverseToTunneler(t *testing.T) {
	tunneler := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/proxy/sess-1/") {
			w.Write([]byte("from tunneler"))
			return
		}
		http.NotFound(w, r)
	}))
	defer tunneler.Close()

	store := testRedisStore(t)
	store.Put(context.Background(), SessionMeta{
		ID:           "sess-1",
		UserID:       "alice@example.com",
		Directory:    "/project",
		TunnelerAddr: tunneler.Listener.Addr().String(),
	})

	handler := GatewayProxyHandler(store)

	req := httptest.NewRequest("GET", "/s/sess-1/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "from tunneler") {
		t.Errorf("body = %q, want 'from tunneler'", rec.Body.String())
	}
}

func TestGatewayProxySessionNotFound(t *testing.T) {
	store := testRedisStore(t)
	handler := GatewayProxyHandler(store)

	req := httptest.NewRequest("GET", "/s/nonexistent/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestGatewayProxyQueryStringForwarding(t *testing.T) {
	tunneler := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("query=" + r.URL.RawQuery))
	}))
	defer tunneler.Close()

	store := testRedisStore(t)
	store.Put(context.Background(), SessionMeta{
		ID:           "sess-1",
		UserID:       "alice@example.com",
		TunnelerAddr: tunneler.Listener.Addr().String(),
	})

	handler := GatewayProxyHandler(store)

	req := httptest.NewRequest("GET", "/s/sess-1/api/session?foo=bar", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !strings.Contains(rec.Body.String(), "foo=bar") {
		t.Errorf("query string not forwarded: body = %q", rec.Body.String())
	}
}

func TestGatewayProxyNoTunnelerAddr(t *testing.T) {
	store := testRedisStore(t)
	store.Put(context.Background(), SessionMeta{
		ID:     "sess-1",
		UserID: "alice@example.com",
	})

	handler := GatewayProxyHandler(store)

	req := httptest.NewRequest("GET", "/s/sess-1/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}
