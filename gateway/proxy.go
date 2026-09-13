package main

import (
	"net/http"
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

		if r.URL.RawQuery != "" {
			downstream += "?" + r.URL.RawQuery
		}

		session, ok := registry.Lookup(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		if session.Tunnel == nil {
			http.Error(w, "session has no tunnel", http.StatusBadGateway)
			return
		}

		if isWebSocketUpgrade(r) {
			session.Tunnel.proxyWebSocketUpgrade(w, r, downstream, session.Directory)
			return
		}

		session.Tunnel.proxyHTTPRequest(w, r, downstream, session.Directory)
	})
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}
