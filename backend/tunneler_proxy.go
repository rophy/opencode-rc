package main

import (
	"net/http"
	"strings"
)

func TunnelerProxyHandler(registry *TunnelRegistry) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// URL: /proxy/{sessionID}/api/...
		// Strip "/proxy/{sessionID}" prefix, pass the rest to the backend.
		path := r.URL.Path
		if !strings.HasPrefix(path, "/proxy/") {
			http.NotFound(w, r)
			return
		}
		rest := path[len("/proxy/"):]
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

		tunnel, ok := registry.GetTunnel(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		meta, _ := registry.GetMeta(r.Context(), sessionID)

		if tunnel == nil {
			http.Error(w, "session has no tunnel", http.StatusBadGateway)
			return
		}

		if isWebSocketUpgrade(r) {
			tunnel.proxyWebSocketUpgrade(w, r, downstream, meta.Directory)
			return
		}

		tunnel.proxyHTTPRequest(w, r, downstream, meta.Directory)
	})
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}
