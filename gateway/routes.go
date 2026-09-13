// gateway/routes.go
package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

func SetupRoutes(mux *http.ServeMux, auth *Auth, registry *Registry, webUIDir string) {
	// Health (unauthenticated)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		marshalJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version})
	})

	// Auth endpoints (unauthenticated)
	mux.HandleFunc("/auth/login", auth.LoginPageHandler)
	mux.HandleFunc("/auth/start", auth.LoginStartHandler)
	mux.HandleFunc("/auth/callback", auth.CallbackHandler)
	mux.HandleFunc("/auth/logout", auth.LogoutHandler)

	// Tunnel endpoint (CLI uses Bearer token auth, upgrades to WebSocket)
	mux.HandleFunc("/gateway/tunnel", TunnelHandler(auth, registry))

	// User info API (browser cookie auth)
	mux.Handle("/api/me", auth.Middleware(MeHandler()))

	// Dashboard + session API (browser cookie auth)
	dashMux := http.NewServeMux()
	dashMux.Handle("/gateway/sessions", DashboardSessionsHandler(registry))
	if webUIDir != "" {
		dashMux.Handle("/", WebUIHandler(webUIDir))
	} else {
		dashMux.Handle("/", DashboardHandler())
	}
	mux.Handle("/gateway/sessions", auth.Middleware(dashMux))
	mux.Handle("/", auth.Middleware(dashMux))

	// Session proxy + web UI (browser cookie auth)
	mux.Handle("/s/", auth.Middleware(SessionWebUIOrProxy(registry, webUIDir)))
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "duration", time.Since(start).Round(time.Millisecond))
	})
}

// marshalJSON is a helper for JSON responses.
func marshalJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
