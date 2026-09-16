package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// wsPair sets up a WebSocket connection between a test server and client,
// returning the server-side and client-side *websocket.Conn.
func wsPair(t *testing.T) (server *websocket.Conn, client *websocket.Conn, cleanup func()) {
	t.Helper()

	serverConnCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade failed: %v", err)
			return
		}
		serverConnCh <- ws
		// Keep the handler alive until the connection is closed.
		for {
			if _, _, err := ws.NextReader(); err != nil {
				return
			}
		}
	}))

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	clientWS, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}

	var serverWS *websocket.Conn
	select {
	case serverWS = <-serverConnCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for server connection")
	}

	cleanup = func() {
		clientWS.Close()
		serverWS.Close()
		srv.Close()
	}

	return serverWS, clientWS, cleanup
}

func TestMuxFrameRoundTrip(t *testing.T) {
	serverWS, clientWS, cleanup := wsPair(t)
	defer cleanup()

	clientMux := newMuxConn(clientWS)
	defer clientMux.close()

	stream := clientMux.openStream()
	defer clientMux.removeStream(stream.id)

	payload := []byte("hello world")
	writeTestFrame(serverWS, stream.id, frameData, payload)

	frame, err := stream.readFrame()
	if err != nil {
		t.Fatalf("read frame failed: %v", err)
	}
	if len(frame) == 0 {
		t.Fatal("expected non-empty frame")
	}
	if frame[0] != frameData {
		t.Errorf("expected frameData type, got %d", frame[0])
	}
	if string(frame[1:]) != string(payload) {
		t.Errorf("expected payload %q, got %q", payload, frame[1:])
	}
}

func TestMuxStreamClose(t *testing.T) {
	_, clientWS, cleanup := wsPair(t)
	defer cleanup()

	clientMux := newMuxConn(clientWS)
	defer clientMux.close()

	stream := clientMux.openStream()
	clientMux.removeStream(stream.id)

	if _, err := stream.readFrame(); err == nil {
		t.Error("expected error reading from removed stream")
	}
}

func TestReadPumpShortMessage(t *testing.T) {
	serverWS, clientWS, cleanup := wsPair(t)
	defer cleanup()

	clientMux := newMuxConn(clientWS)
	defer clientMux.close()

	stream := clientMux.openStream()
	defer clientMux.removeStream(stream.id)

	// Send a message with fewer than 5 bytes (too short to have streamID + frameType)
	serverWS.WriteMessage(websocket.BinaryMessage, []byte{0x01, 0x02})

	// Then send a real frame to verify readPump is still working
	writeTestFrame(serverWS, stream.id, frameData, []byte("after-short"))

	frame, err := stream.readFrame()
	if err != nil {
		t.Fatalf("readFrame failed: %v", err)
	}
	if !strings.Contains(string(frame[1:]), "after-short") {
		t.Errorf("expected 'after-short', got: %s", string(frame[1:]))
	}
}

func TestReadPumpDispatchToClosedStream(t *testing.T) {
	serverWS, clientWS, cleanup := wsPair(t)
	defer cleanup()

	clientMux := newMuxConn(clientWS)
	defer clientMux.close()

	stream := clientMux.openStream()

	// Fill the incoming channel to capacity (64 items)
	for i := 0; i < 64; i++ {
		writeTestFrame(serverWS, stream.id, frameData, []byte("fill"))
	}
	// Give readPump time to fill the channel
	time.Sleep(100 * time.Millisecond)

	// Now close the stream while readPump might try to dispatch another frame
	clientMux.removeStream(stream.id)

	// Send another frame - readPump should hit the s.done case
	writeTestFrame(serverWS, stream.id, frameData, []byte("after-close"))

	// Give readPump time to process
	time.Sleep(100 * time.Millisecond)
}

func TestReadFrameStreamDone(t *testing.T) {
	_, clientWS, cleanup := wsPair(t)
	defer cleanup()

	clientMux := newMuxConn(clientWS)
	defer clientMux.close()

	stream := clientMux.openStream()
	clientMux.removeStream(stream.id) // closes stream.done

	_, err := stream.readFrame()
	if err == nil {
		t.Error("expected error from readFrame on done stream")
	}
	if !strings.Contains(err.Error(), "stream closed") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestReadFrameTunnelClosed(t *testing.T) {
	serverWS, clientWS, cleanup := wsPair(t)
	defer cleanup()

	clientMux := newMuxConn(clientWS)
	stream := clientMux.openStream()

	// Close the tunnel
	serverWS.Close()
	select {
	case <-clientMux.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out")
	}

	_, err := stream.readFrame()
	if err == nil {
		t.Error("expected error from readFrame on closed tunnel")
	}
	// readPump closes all streams on exit, so either "stream closed" or "tunnel closed"
	if !strings.Contains(err.Error(), "closed") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestReadResponseHeadersBadFrameType(t *testing.T) {
	serverWS, clientWS, cleanup := wsPair(t)
	defer cleanup()

	clientMux := newMuxConn(clientWS)
	defer clientMux.close()

	stream := clientMux.openStream()
	defer clientMux.removeStream(stream.id)

	writeTestFrame(serverWS, stream.id, frameData, []byte("not response headers"))

	_, err := stream.readResponseHeaders()
	if err == nil {
		t.Fatal("expected error for non-response-headers frame")
	}
	if !strings.Contains(err.Error(), "expected response headers frame") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestProxyWebSocketUpgradeNon101(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})

	mux, cleanup := testTunnel(t, backend)
	defer cleanup()

	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	reg.Register(t.Context(), "user1", "ws-sess", "/proj", "", mux)

	handler := GatewayProxyHandler(reg)

	req := httptest.NewRequest("GET", "/proxy/ws-sess/ws", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 for non-101 WebSocket response, got %d", rec.Code)
	}
}

func TestProxyWebSocketUpgrade101WithHijack(t *testing.T) {
	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}

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

			switch frameType {
			case frameRequestHeaders:
				respH := responseHeaders{
					Status:  101,
					Headers: map[string]string{"Upgrade": "websocket", "Connection": "Upgrade"},
				}
				respPayload, _ := json.Marshal(respH)
				writeTestFrame(ws, streamID, frameResponseHeaders, respPayload)

				writeTestFrame(ws, streamID, frameData, []byte("ws-data"))
				writeTestFrame(ws, streamID, frameEnd, nil)
				return
			}
		}
	}))
	defer wsSrv.Close()

	wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
	tunnelWS, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	mux := newMuxConn(tunnelWS)
	defer mux.close()

	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.proxyWebSocketUpgrade(w, r, "/ws", "/proj")
	}))
	defer proxySrv.Close()

	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(proxySrv.URL, "http://"), 2*time.Second)
	if err != nil {
		t.Fatalf("tcp dial failed: %v", err)
	}
	defer conn.Close()

	fmt.Fprintf(conn, "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	resp := string(buf[:n])
	if !strings.Contains(resp, "101 Switching Protocols") {
		t.Errorf("expected 101 response, got: %s", resp)
	}
	if !strings.Contains(resp, "ws-data") {
		n2, _ := conn.Read(buf)
		resp += string(buf[:n2])
	}
	if !strings.Contains(resp, "ws-data") {
		t.Errorf("expected ws-data in response, got: %s", resp)
	}
}

func TestProxyHTTPRequestWithBody(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := make([]byte, 1024)
		n, _ := r.Body.Read(body)
		w.Write(body[:n])
	})

	mux, cleanup := testTunnelWithBody(t, backend)
	defer cleanup()

	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	reg.Register(t.Context(), "user1", "sess-body", "/proj", "", mux)

	handler := GatewayProxyHandler(reg)
	req := httptest.NewRequest("POST", "/proxy/sess-body/api/prompt", strings.NewReader(`{"msg":"hello"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"msg":"hello"`) {
		t.Errorf("expected echoed body, got: %s", rec.Body.String())
	}
}

func TestProxyHTTPRequestRSTFrame(t *testing.T) {
	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
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
			if frameType == frameRequestHeaders {
				respH := responseHeaders{Status: 200, Headers: map[string]string{}}
				respPayload, _ := json.Marshal(respH)
				writeTestFrame(ws, streamID, frameResponseHeaders, respPayload)
				writeTestFrame(ws, streamID, frameRST, nil)
			}
		}
	}))
	defer wsSrv.Close()

	wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
	tunnelWS, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	mux := newMuxConn(tunnelWS)
	defer mux.close()

	req := httptest.NewRequest("GET", "/api/test", nil)
	rec := httptest.NewRecorder()
	mux.proxyHTTPRequest(rec, req, "/api/test", "/proj")

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestReadResponseHeadersBadJSON(t *testing.T) {
	serverWS, clientWS, cleanup := wsPair(t)
	defer cleanup()

	clientMux := newMuxConn(clientWS)
	defer clientMux.close()

	stream := clientMux.openStream()
	defer clientMux.removeStream(stream.id)

	writeTestFrame(serverWS, stream.id, frameResponseHeaders, []byte("not-json"))

	_, err := stream.readResponseHeaders()
	if err == nil {
		t.Fatal("expected error for bad JSON in response headers")
	}
	if !strings.Contains(err.Error(), "invalid response headers") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestMuxCloseNilWS(t *testing.T) {
	m := &muxConn{closed: make(chan struct{})}
	if err := m.close(); err != nil {
		t.Errorf("expected nil error for nil ws, got %v", err)
	}
}

func TestProxyWebSocketUpgradeWriteFrameError(t *testing.T) {
	_, clientWS, cleanup := wsPair(t)
	cleanup()

	mux := newMuxConn(clientWS)

	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Upgrade", "websocket")
	rec := httptest.NewRecorder()
	mux.proxyWebSocketUpgrade(rec, req, "/ws", "/proj")

	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502 for writeFrame error, got %d", rec.Code)
	}
}

func TestProxyWebSocketUpgradeReadRespError(t *testing.T) {
	// Server receives request then closes without responding
	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		ws.ReadMessage()
		ws.Close()
	}))
	defer wsSrv.Close()

	wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
	tunnelWS, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	mux := newMuxConn(tunnelWS)
	defer mux.close()

	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Upgrade", "websocket")
	rec := httptest.NewRecorder()
	mux.proxyWebSocketUpgrade(rec, req, "/ws", "/proj")

	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502, got %d", rec.Code)
	}
}

type failingHijackRecorder struct {
	*httptest.ResponseRecorder
}

func (f *failingHijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, fmt.Errorf("hijack deliberately failed")
}

func TestProxyWebSocketUpgradeHijackError(t *testing.T) {
	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
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
			if frameType == frameRequestHeaders {
				respH := responseHeaders{
					Status:  101,
					Headers: map[string]string{"Upgrade": "websocket"},
				}
				respPayload, _ := json.Marshal(respH)
				writeTestFrame(ws, streamID, frameResponseHeaders, respPayload)
			}
		}
	}))
	defer wsSrv.Close()

	wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
	tunnelWS, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	mux := newMuxConn(tunnelWS)
	defer mux.close()

	// Use a ResponseWriter that IS a Hijacker but fails when Hijack() is called
	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Upgrade", "websocket")
	rec := &failingHijackRecorder{httptest.NewRecorder()}
	mux.proxyWebSocketUpgrade(rec, req, "/ws", "/proj")

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for hijack error, got %d", rec.Code)
	}
}

func TestProxyWebSocketUpgradeHijackNotSupported(t *testing.T) {
	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
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
			if frameType == frameRequestHeaders {
				respH := responseHeaders{
					Status:  101,
					Headers: map[string]string{"Upgrade": "websocket"},
				}
				respPayload, _ := json.Marshal(respH)
				writeTestFrame(ws, streamID, frameResponseHeaders, respPayload)
			}
		}
	}))
	defer wsSrv.Close()

	wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
	tunnelWS, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	mux := newMuxConn(tunnelWS)
	defer mux.close()

	// httptest.NewRecorder doesn't implement http.Hijacker
	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Upgrade", "websocket")
	rec := httptest.NewRecorder()
	mux.proxyWebSocketUpgrade(rec, req, "/ws", "/proj")

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for non-hijackable ResponseWriter, got %d", rec.Code)
	}
}

func TestProxyHTTPRequestBodySendError(t *testing.T) {
	// Server accepts request headers then immediately drops connection
	// while the client is sending body data frames
	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		// Read one frame (request headers) then close aggressively
		ws.ReadMessage()
		ws.UnderlyingConn().Close()
	}))
	defer wsSrv.Close()

	wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
	tunnelWS, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	mux := newMuxConn(tunnelWS)
	defer mux.close()

	// Send a large body to increase chance of hitting write error
	largeBody := strings.Repeat("x", 64*1024)
	req := httptest.NewRequest("POST", "/api/test", strings.NewReader(largeBody))
	req.Header.Set("Content-Type", "application/octet-stream")
	rec := httptest.NewRecorder()
	mux.proxyHTTPRequest(rec, req, "/api/test", "/proj")

	// Either 502 (writeFrame error during body send) or 502 (readResponseHeaders error)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502 for body send error, got %d", rec.Code)
	}
}

func TestProxyHTTPRequestReadResponseError(t *testing.T) {
	// Server receives request headers then closes connection without responding
	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		// Read the first request frame, then close without responding
		ws.ReadMessage()
		ws.Close()
	}))
	defer wsSrv.Close()

	wsURL := "ws" + strings.TrimPrefix(wsSrv.URL, "http")
	tunnelWS, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	mux := newMuxConn(tunnelWS)
	defer mux.close()

	req := httptest.NewRequest("GET", "/api/test", nil)
	rec := httptest.NewRecorder()
	mux.proxyHTTPRequest(rec, req, "/api/test", "/proj")

	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502 for read response error, got %d", rec.Code)
	}
}

func TestProxyHTTPRequestClosedTunnel(t *testing.T) {
	_, clientWS, cleanup := wsPair(t)
	cleanup()

	mux := newMuxConn(clientWS)

	req := httptest.NewRequest("GET", "/api/health", nil)
	rec := httptest.NewRecorder()
	mux.proxyHTTPRequest(rec, req, "/api/health", "/proj")

	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502 for closed tunnel, got %d", rec.Code)
	}
}
