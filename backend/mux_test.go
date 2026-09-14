package main

import (
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
