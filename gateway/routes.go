// gateway/routes.go
package main

import (
	"encoding/json"
	"net/http"
)

func SetupRoutes(mux *http.ServeMux, auth *Auth, registry *Registry, webUIDir string) {
	// Health (unauthenticated)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok\n"))
	})

	// Auth endpoints (unauthenticated)
	mux.HandleFunc("/auth/login", auth.LoginHandler)
	mux.HandleFunc("/auth/callback", auth.CallbackHandler)

	// Registration API (CLI uses Bearer token auth)
	regMux := http.NewServeMux()
	regMux.HandleFunc("POST /gateway/register", registrationHandler(registry))
	regMux.HandleFunc("POST /gateway/heartbeat", heartbeatHandler(registry))
	regMux.HandleFunc("POST /gateway/deregister", deregisterHandler(registry))
	mux.Handle("/gateway/register", auth.RegistrationAuthMiddleware(regMux))
	mux.Handle("/gateway/heartbeat", auth.RegistrationAuthMiddleware(regMux))
	mux.Handle("/gateway/deregister", auth.RegistrationAuthMiddleware(regMux))

	// Dashboard + session API (browser cookie auth)
	dashMux := http.NewServeMux()
	dashMux.Handle("/gateway/sessions", DashboardSessionsHandler(registry))
	dashMux.Handle("/", DashboardHandler())
	mux.Handle("/gateway/sessions", auth.Middleware(dashMux))
	mux.Handle("/", auth.Middleware(dashMux))

	// Session proxy + web UI (browser cookie auth)
	mux.Handle("/s/", auth.Middleware(SessionWebUIOrProxy(registry, webUIDir)))
}

type registerRequest struct {
	SessionID string `json:"sessionId"`
	Endpoint  string `json:"endpoint"`
	Directory string `json:"directory"`
}

func registrationHandler(registry *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := UserFromContext(r.Context())
		var req registerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if req.SessionID == "" || req.Endpoint == "" {
			http.Error(w, "sessionId and endpoint required", http.StatusBadRequest)
			return
		}
		registry.Register(userID, req.SessionID, req.Endpoint, req.Directory)
		marshalJSON(w, http.StatusOK, map[string]string{"status": "registered"})
	}
}

type heartbeatRequest struct {
	SessionID string `json:"sessionId"`
}

func heartbeatHandler(registry *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req heartbeatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if !registry.Heartbeat(req.SessionID) {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		marshalJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

type deregisterRequest struct {
	SessionID string `json:"sessionId"`
}

func deregisterHandler(registry *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req deregisterRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		registry.Deregister(req.SessionID)
		marshalJSON(w, http.StatusOK, map[string]string{"status": "deregistered"})
	}
}
