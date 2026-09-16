// webui_test.go
package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWebUIHandler(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>index</html>"), 0644); err != nil {
		t.Fatalf("failed to write index.html: %v", err)
	}

	handler := WebUIHandler(dir)

	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "index") {
		t.Errorf("expected index.html content, got: %s", rec.Body.String())
	}

	req = httptest.NewRequest("GET", "/nonexistent.js", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 (SPA fallback), got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "index") {
		t.Errorf("expected SPA fallback to index.html, got: %s", rec.Body.String())
	}
}

func TestWebUIHandlerStaticFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>index</html>"), 0644); err != nil {
		t.Fatalf("failed to write index.html: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte("console.log('app')"), 0644); err != nil {
		t.Fatalf("failed to write app.js: %v", err)
	}

	handler := WebUIHandler(dir)

	req := httptest.NewRequest("GET", "/app.js", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "console.log") {
		t.Errorf("expected app.js content, got: %s", rec.Body.String())
	}
}

func TestSessionWebUIOrProxy(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>index</html>"), 0644); err != nil {
		t.Fatalf("failed to write index.html: %v", err)
	}

	store := testRedisStore(t)
	ctx := context.Background()
	store.Put(ctx, SessionMeta{ID: "sess1", UserID: "user1", Directory: "/proj"})

	handler := SessionWebUIOrProxy(store, dir)

	// 1. Non /s/ prefix -> 404
	req := httptest.NewRequest("GET", "/notS/foo", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("case 1: expected 404, got %d", rec.Code)
	}

	// 2. /s/sess1 (no trailing slash) -> redirect
	req = httptest.NewRequest("GET", "/s/sess1", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Errorf("case 2: expected 302, got %d", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/s/sess1/" {
		t.Errorf("case 2: expected redirect to /s/sess1/, got %s", loc)
	}

	// 3. /s/nonexistent/ -> 404
	req = httptest.NewRequest("GET", "/s/nonexistent/", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("case 3: expected 404, got %d", rec.Code)
	}

	// 4. /s/sess1/ with webUIDir set -> serves index.html
	req = httptest.NewRequest("GET", "/s/sess1/", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("case 4: expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "index") {
		t.Errorf("case 4: expected index.html content, got: %s", rec.Body.String())
	}

	// 5. /s/sess1/app.js (static file on disk) -> served from webUIDir
	jsFile := filepath.Join(dir, "app.js")
	if err := os.WriteFile(jsFile, []byte("console.log('app')"), 0644); err != nil {
		t.Fatalf("failed to write app.js: %v", err)
	}
	req = httptest.NewRequest("GET", "/s/sess1/app.js", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("case 5: expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "console.log") {
		t.Errorf("case 5: expected app.js content, got: %s", rec.Body.String())
	}

	// 6. /s/sess1/api/health -> proxied through tunneler
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("healthy"))
	}))
	defer backend.Close()

	store.Put(ctx, SessionMeta{ID: "sess1", UserID: "user1", Directory: "/proj", TunnelerAddr: backend.Listener.Addr().String()})

	req = httptest.NewRequest("GET", "/s/sess1/api/health", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("case 6: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "healthy") {
		t.Errorf("case 6: expected proxied content, got: %s", rec.Body.String())
	}
}

func TestSessionWebUIOrProxyUserMismatch(t *testing.T) {
	store := testRedisStore(t)
	ctx := context.Background()
	store.Put(ctx, SessionMeta{ID: "sess1", UserID: "alice@example.com", Directory: "/proj"})

	handler := SessionWebUIOrProxy(store, "")

	req := httptest.NewRequest("GET", "/s/sess1/api/health", nil)
	reqCtx := context.WithValue(req.Context(), userContextKey, "bob@example.com")
	req = req.WithContext(reqCtx)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 for user mismatch, got %d", rec.Code)
	}
}

func TestSessionWebUIOrProxyStoreError(t *testing.T) {
	store := testBrokenStore(t)
	handler := SessionWebUIOrProxy(store, "")

	req := httptest.NewRequest("GET", "/s/sess1/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for store error, got %d", rec.Code)
	}
}

func TestSessionWebUIOrProxyNoWebUIDir(t *testing.T) {
	store := testRedisStore(t)
	ctx := context.Background()

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("proxied"))
	}))
	defer backend.Close()

	store.Put(ctx, SessionMeta{ID: "sess1", UserID: "user1", Directory: "/proj", TunnelerAddr: backend.Listener.Addr().String()})

	handler := SessionWebUIOrProxy(store, "")

	// Without webUIDir, root path goes to proxy
	req := httptest.NewRequest("GET", "/s/sess1/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}
