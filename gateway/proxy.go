package main

import (
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

func ProxyHandler(registry *Registry) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// URL: /s/{sessionID}/api/...
		// Strip "/s/{sessionID}" prefix, pass the rest to the backend.
		path := r.URL.Path
		if !strings.HasPrefix(path, "/s/") {
			http.NotFound(w, r)
			return
		}
		rest := path[len("/s/"):]
		slashIdx := strings.Index(rest, "/")
		if slashIdx < 0 {
			http.NotFound(w, r)
			return
		}
		sessionID := rest[:slashIdx]
		downstream := rest[slashIdx:] // e.g. "/api/session"

		session, ok := registry.Lookup(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		target, err := url.Parse(session.Endpoint)
		if err != nil {
			http.Error(w, "bad endpoint", http.StatusBadGateway)
			return
		}

		// WebSocket upgrade
		if isWebSocketUpgrade(r) {
			proxyWebSocket(w, r, target, downstream, session)
			return
		}

		proxy := &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL.Scheme = target.Scheme
				req.URL.Host = target.Host
				req.URL.Path = downstream
				req.URL.RawQuery = r.URL.RawQuery
				req.Host = target.Host
				req.Header.Set("X-Opencode-Directory", session.Directory)
			},
			FlushInterval: -1, // flush immediately for SSE
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				log.Printf("proxy error session=%s: %v", sessionID, err)
				http.Error(w, "bad gateway", http.StatusBadGateway)
			},
		}

		proxy.ServeHTTP(w, r)
	})
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func proxyWebSocket(w http.ResponseWriter, r *http.Request, target *url.URL, path string, session *Session) {
	backendURL := *target
	backendURL.Path = path
	backendURL.RawQuery = r.URL.RawQuery

	// Dial backend
	backendConn, err := net.Dial("tcp", target.Host)
	if err != nil {
		http.Error(w, "backend unavailable", http.StatusBadGateway)
		return
	}
	defer backendConn.Close()

	// Hijack client connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, "hijack failed", http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	// Forward the original HTTP request to the backend to initiate the upgrade
	r.URL = &backendURL
	r.Host = target.Host
	r.Header.Set("X-Opencode-Directory", session.Directory)
	if err := r.Write(backendConn); err != nil {
		return
	}

	// Bidirectional copy
	done := make(chan struct{}, 2)
	go func() {
		io.Copy(backendConn, clientConn)
		done <- struct{}{}
	}()
	go func() {
		io.Copy(clientConn, backendConn)
		done <- struct{}{}
	}()
	<-done
}
