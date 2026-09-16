package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// testTunnel sets up a WebSocket server, creates a muxConn, and runs a
// goroutine that proxies tunnel requests to the given backend HTTP handler.
func testTunnel(t *testing.T, backend http.Handler) (*muxConn, func()) {
	t.Helper()

	// WebSocket server that the muxConn connects to
	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade failed: %v", err)
			return
		}

		// CLI side: read frames and proxy to backend
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if len(msg) < 5 {
				continue
			}
			streamID := binary.BigEndian.Uint32(msg[:4])
			frameType := msg[4]
			payload := msg[5:]

			if frameType != frameRequestHeaders {
				continue
			}

			var reqH requestHeaders
			if err := json.Unmarshal(payload, &reqH); err != nil {
				continue
			}

			// Proxy to backend
			path := reqH.Path
			req := httptest.NewRequest(reqH.Method, path, nil)
			for k, v := range reqH.Headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			backend.ServeHTTP(rec, req)

			// Send response headers
			respHdrs := make(map[string]string)
			for k := range rec.Header() {
				respHdrs[k] = rec.Header().Get(k)
			}
			respH := responseHeaders{
				Status:  rec.Code,
				Headers: respHdrs,
			}
			respPayload, _ := json.Marshal(respH)
			writeTestFrame(ws, streamID, frameResponseHeaders, respPayload)

			// Send response body
			body := rec.Body.Bytes()
			if len(body) > 0 {
				writeTestFrame(ws, streamID, frameData, body)
			}
			writeTestFrame(ws, streamID, frameEnd, nil)
		}
	}))

	// Connect server-side muxConn to the WS server
	wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}

	mux := newMuxConn(ws)

	cleanup := func() {
		mux.close()
		wsSrv.Close()
	}

	return mux, cleanup
}

// testTunnelWithBody is like testTunnel but also reads DATA/END frames sent
// after the request headers to assemble a request body for the backend.
func testTunnelWithBody(t *testing.T, backend http.Handler) (*muxConn, func()) {
	t.Helper()

	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade failed: %v", err)
			return
		}

		var reqH requestHeaders
		var bodyBuf bytes.Buffer
		readingBody := false

		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if len(msg) < 5 {
				continue
			}
			streamID := binary.BigEndian.Uint32(msg[:4])
			frameType := msg[4]
			payload := msg[5:]

			switch frameType {
			case frameRequestHeaders:
				if err := json.Unmarshal(payload, &reqH); err != nil {
					continue
				}
				bodyBuf.Reset()
				if reqH.HasBody {
					readingBody = true
					continue
				}
				readingBody = false
				proxyToBackend(backend, ws, streamID, reqH, nil)
			case frameData:
				if readingBody {
					bodyBuf.Write(payload)
				}
			case frameEnd:
				if readingBody {
					readingBody = false
					proxyToBackend(backend, ws, streamID, reqH, bodyBuf.Bytes())
				}
			}
		}
	}))

	wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}

	mux := newMuxConn(ws)

	cleanup := func() {
		mux.close()
		wsSrv.Close()
	}

	return mux, cleanup
}

func proxyToBackend(backend http.Handler, ws *websocket.Conn, streamID uint32, reqH requestHeaders, body []byte) {
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req := httptest.NewRequest(reqH.Method, reqH.Path, bodyReader)
	for k, v := range reqH.Headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	backend.ServeHTTP(rec, req)

	respHdrs := make(map[string]string)
	for k := range rec.Header() {
		respHdrs[k] = rec.Header().Get(k)
	}
	respH := responseHeaders{
		Status:  rec.Code,
		Headers: respHdrs,
	}
	respPayload, _ := json.Marshal(respH)
	writeTestFrame(ws, streamID, frameResponseHeaders, respPayload)

	respBody := rec.Body.Bytes()
	if len(respBody) > 0 {
		writeTestFrame(ws, streamID, frameData, respBody)
	}
	writeTestFrame(ws, streamID, frameEnd, nil)
}

func writeTestFrame(ws *websocket.Conn, streamID uint32, frameType byte, payload []byte) {
	header := make([]byte, 5)
	binary.BigEndian.PutUint32(header[:4], streamID)
	header[4] = frameType
	msg := append(header, payload...)
	ws.WriteMessage(websocket.BinaryMessage, msg)
}

func TestTunnelerProxyHTTP(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/session" {
			t.Errorf("expected /api/session, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"sessions":[]}`))
	})

	mux, cleanup := testTunnel(t, backend)
	defer cleanup()

	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	reg.Register(t.Context(), "user1", "sess1", "/proj", "", mux)

	handler := TunnelerProxyHandler(reg)
	req := httptest.NewRequest("GET", "/proxy/sess1/api/session", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "sessions") {
		t.Errorf("unexpected body: %s", rec.Body.String())
	}
}

func TestTunnelerProxySSE(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		fmt.Fprint(w, "event: message\ndata: {\"i\":0}\n\n")
		fmt.Fprint(w, "event: message\ndata: {\"i\":1}\n\n")
	})

	mux, cleanup := testTunnel(t, backend)
	defer cleanup()

	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	reg.Register(t.Context(), "user1", "sess1", "/proj", "", mux)

	handler := TunnelerProxyHandler(reg)
	req := httptest.NewRequest("GET", "/proxy/sess1/api/event", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Header().Get("Content-Type") != "text/event-stream" {
		t.Errorf("expected text/event-stream, got %s", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "event: message") {
		t.Errorf("expected SSE events, got: %s", rec.Body.String())
	}
}

func TestTunnelerProxyQueryStringForwarding(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "foo=bar&baz=1" {
			t.Errorf("expected query foo=bar&baz=1, got %s", r.URL.RawQuery)
		}
		w.WriteHeader(http.StatusOK)
	})

	mux, cleanup := testTunnel(t, backend)
	defer cleanup()

	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	reg.Register(t.Context(), "user1", "sess1", "/proj", "", mux)

	handler := TunnelerProxyHandler(reg)
	req := httptest.NewRequest("GET", "/proxy/sess1/api/session?foo=bar&baz=1", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestTunnelerProxyWithRequestBody(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("failed to read body: %v", err)
		}
		w.Write(body)
	})

	mux, cleanup := testTunnelWithBody(t, backend)
	defer cleanup()

	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	reg.Register(t.Context(), "user1", "sess1", "/proj", "", mux)

	handler := TunnelerProxyHandler(reg)
	req := httptest.NewRequest("POST", "/proxy/sess1/api/session/prompt", strings.NewReader(`{"prompt":"hello"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"prompt":"hello"`) {
		t.Errorf("expected echoed body, got: %s", rec.Body.String())
	}
}

func TestTunnelerProxyNoTunnel(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	reg.Register(t.Context(), "user1", "sess1", "/proj", "", nil)

	handler := TunnelerProxyHandler(reg)
	req := httptest.NewRequest("GET", "/proxy/sess1/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "session has no tunnel") {
		t.Errorf("expected 'session has no tunnel' in body, got: %s", rec.Body.String())
	}
}

func TestTunnelerProxyInvalidPath(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelerProxyHandler(reg)

	for _, path := range []string{"/notProxy/sess1/api/health", "/proxy/"} {
		req := httptest.NewRequest("GET", path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Errorf("path %s: expected 404, got %d", path, rec.Code)
		}
	}
}

func TestTunnelerProxySessionNotFound(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	handler := TunnelerProxyHandler(reg)

	req := httptest.NewRequest("GET", "/proxy/nonexistent/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
}

func TestTunnelerProxyAddsDirectoryHeader(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dir := r.Header.Get("X-Opencode-Directory")
		if dir != "/home/user1/project" {
			t.Errorf("expected X-Opencode-Directory=/home/user1/project, got %s", dir)
		}
		w.WriteHeader(http.StatusOK)
	})

	mux, cleanup := testTunnel(t, backend)
	defer cleanup()

	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	reg.Register(t.Context(), "user1", "sess1", "/home/user1/project", "", mux)

	handler := TunnelerProxyHandler(reg)
	req := httptest.NewRequest("GET", "/proxy/sess1/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}
