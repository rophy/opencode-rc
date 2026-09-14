package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
)

// Frame types for the tunnel mux protocol.
const (
	frameRequestHeaders  byte = 0x01
	frameResponseHeaders byte = 0x02
	frameData            byte = 0x03
	frameEnd             byte = 0x04
	frameRST             byte = 0x05
)

// requestHeaders is sent gateway → CLI to start a new proxied request.
type requestHeaders struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	HasBody bool              `json:"hasBody"`
}

// responseHeaders is sent CLI → gateway with the proxied response.
type responseHeaders struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
}

// muxConn wraps a WebSocket connection with stream multiplexing.
type muxConn struct {
	ws       *websocket.Conn
	mu       sync.Mutex // protects ws writes
	nextID   atomic.Uint32
	streams  sync.Map // streamID → *muxStream
	closed   chan struct{}
	closeErr error
}

type muxStream struct {
	id       uint32
	conn     *muxConn
	incoming chan []byte // raw frames (type + payload) from readPump
	done     chan struct{}
}

func newMuxConn(ws *websocket.Conn) *muxConn {
	m := &muxConn{
		ws:     ws,
		closed: make(chan struct{}),
	}
	go m.readPump()
	return m
}

// openStream creates a new stream for a proxied request.
func (m *muxConn) openStream() *muxStream {
	id := m.nextID.Add(1)
	s := &muxStream{
		id:       id,
		conn:     m,
		incoming: make(chan []byte, 64),
		done:     make(chan struct{}),
	}
	m.streams.Store(id, s)
	return s
}

func (m *muxConn) removeStream(id uint32) {
	if s, ok := m.streams.LoadAndDelete(id); ok {
		st := s.(*muxStream)
		select {
		case <-st.done:
		default:
			close(st.done)
		}
	}
}

// writeFrame sends a frame on the WebSocket (thread-safe).
func (m *muxConn) writeFrame(streamID uint32, frameType byte, payload []byte) error {
	header := make([]byte, 5)
	binary.BigEndian.PutUint32(header[:4], streamID)
	header[4] = frameType

	m.mu.Lock()
	defer m.mu.Unlock()

	w, err := m.ws.NextWriter(websocket.BinaryMessage)
	if err != nil {
		return err
	}
	if _, err := w.Write(header); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	return w.Close()
}

// readPump reads frames from WebSocket and dispatches to streams.
func (m *muxConn) readPump() {
	defer func() {
		m.closeErr = fmt.Errorf("tunnel closed")
		close(m.closed)
		m.streams.Range(func(key, value any) bool {
			s := value.(*muxStream)
			select {
			case <-s.done:
			default:
				close(s.done)
			}
			return true
		})
	}()

	for {
		_, msg, err := m.ws.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				slog.Debug("tunnel read error", "error", err)
			}
			return
		}
		if len(msg) < 5 {
			continue
		}

		streamID := binary.BigEndian.Uint32(msg[:4])
		frame := msg[4:] // type byte + payload

		val, ok := m.streams.Load(streamID)
		if !ok {
			continue
		}
		s := val.(*muxStream)

		select {
		case s.incoming <- frame:
		case <-s.done:
		case <-m.closed:
			return
		}
	}
}

// close shuts down the mux connection.
func (m *muxConn) close() error {
	if m.ws == nil {
		return nil
	}
	return m.ws.Close()
}

// proxyHTTPRequest sends an HTTP request through the tunnel and writes the
// response to the provided http.ResponseWriter. It handles streaming (SSE).
func (m *muxConn) proxyHTTPRequest(w http.ResponseWriter, r *http.Request, downstream string, directory string) {
	stream := m.openStream()
	defer m.removeStream(stream.id)

	// Build request headers
	hdrs := make(map[string]string)
	for k := range r.Header {
		hdrs[k] = r.Header.Get(k)
	}
	hdrs["X-Opencode-Directory"] = directory

	hasBody := r.Body != nil && r.ContentLength != 0
	reqH := requestHeaders{
		Method:  r.Method,
		Path:    downstream,
		Headers: hdrs,
		HasBody: hasBody,
	}
	payload, err := json.Marshal(reqH)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if err := m.writeFrame(stream.id, frameRequestHeaders, payload); err != nil {
		http.Error(w, "tunnel write error", http.StatusBadGateway)
		return
	}

	// Send request body if present
	if hasBody {
		buf := make([]byte, 32*1024)
		for {
			n, readErr := r.Body.Read(buf)
			if n > 0 {
				if err := m.writeFrame(stream.id, frameData, buf[:n]); err != nil {
					http.Error(w, "tunnel write error", http.StatusBadGateway)
					return
				}
			}
			if readErr != nil {
				break
			}
		}
		if err := m.writeFrame(stream.id, frameEnd, nil); err != nil {
			http.Error(w, "tunnel write error", http.StatusBadGateway)
			return
		}
	}

	// Read response headers
	respH, err := stream.readResponseHeaders()
	if err != nil {
		slog.Error("tunnel response error", "stream", stream.id, "error", err)
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}

	// Copy response headers to browser
	for k, v := range respH.Headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(respH.Status)

	// Stream response body
	flusher, canFlush := w.(http.Flusher)

	for {
		frame, err := stream.readFrame()
		if err != nil {
			return
		}
		if len(frame) == 0 {
			continue
		}

		frameType := frame[0]
		payload := frame[1:]

		switch frameType {
		case frameData:
			if _, err := w.Write(payload); err != nil {
				return
			}
			if canFlush {
				flusher.Flush()
			}
		case frameEnd:
			return
		case frameRST:
			return
		}
	}
}

// readFrame reads the next frame for this stream.
func (s *muxStream) readFrame() ([]byte, error) {
	select {
	case frame := <-s.incoming:
		return frame, nil
	case <-s.done:
		return nil, fmt.Errorf("stream closed")
	case <-s.conn.closed:
		return nil, fmt.Errorf("tunnel closed")
	}
}

// readResponseHeaders reads and parses the RESPONSE_HEADERS frame.
func (s *muxStream) readResponseHeaders() (*responseHeaders, error) {
	frame, err := s.readFrame()
	if err != nil {
		return nil, err
	}
	if len(frame) < 2 || frame[0] != frameResponseHeaders {
		return nil, fmt.Errorf("expected response headers frame, got type %d", frame[0])
	}

	var resp responseHeaders
	if err := json.Unmarshal(frame[1:], &resp); err != nil {
		return nil, fmt.Errorf("invalid response headers: %w", err)
	}
	return &resp, nil
}

// proxyWebSocketUpgrade handles WebSocket upgrade requests through the tunnel.
func (m *muxConn) proxyWebSocketUpgrade(w http.ResponseWriter, r *http.Request, downstream string, directory string) {
	stream := m.openStream()
	defer m.removeStream(stream.id)

	hdrs := make(map[string]string)
	for k := range r.Header {
		hdrs[k] = r.Header.Get(k)
	}
	hdrs["X-Opencode-Directory"] = directory

	reqH := requestHeaders{
		Method:  r.Method,
		Path:    downstream,
		Headers: hdrs,
		HasBody: false,
	}
	payload, err := json.Marshal(reqH)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if err := m.writeFrame(stream.id, frameRequestHeaders, payload); err != nil {
		http.Error(w, "tunnel write error", http.StatusBadGateway)
		return
	}

	// Read response — expect 101 Switching Protocols
	respH, err := stream.readResponseHeaders()
	if err != nil {
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}

	if respH.Status != http.StatusSwitchingProtocols {
		for k, v := range respH.Headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(respH.Status)
		return
	}

	// Hijack the browser connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket not supported", http.StatusInternalServerError)
		return
	}
	clientConn, clientBuf, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, "hijack failed", http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	// Write 101 response to browser
	resp := fmt.Sprintf("HTTP/1.1 101 Switching Protocols\r\n")
	for k, v := range respH.Headers {
		resp += fmt.Sprintf("%s: %s\r\n", k, v)
	}
	resp += "\r\n"
	clientBuf.WriteString(resp)
	clientBuf.Flush()

	// Bidirectional: browser → tunnel and tunnel → browser
	done := make(chan struct{}, 2)

	// Browser → tunnel
	go func() {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 32*1024)
		reader := bufio.NewReader(clientConn)
		for {
			n, err := reader.Read(buf)
			if n > 0 {
				if writeErr := m.writeFrame(stream.id, frameData, buf[:n]); writeErr != nil {
					return
				}
			}
			if err != nil {
				m.writeFrame(stream.id, frameEnd, nil)
				return
			}
		}
	}()

	// Tunnel → browser
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			frame, err := stream.readFrame()
			if err != nil {
				return
			}
			if len(frame) == 0 {
				continue
			}
			switch frame[0] {
			case frameData:
				if _, err := clientConn.Write(frame[1:]); err != nil {
					return
				}
			case frameEnd, frameRST:
				return
			}
		}
	}()

	<-done
}
