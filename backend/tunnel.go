package main

import (
	"log/slog"
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// TunnelHandler upgrades a CLI connection to a WebSocket tunnel.
// The CLI authenticates with a Bearer token and provides a sessionID.
// The gateway registers the session with the tunnel mux connection.
func TunnelHandler(auth *Auth, registry *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Validate Bearer token
		token := r.Header.Get("Authorization")
		if len(token) < 8 || token[:7] != "Bearer " {
			http.Error(w, "missing authorization", http.StatusUnauthorized)
			return
		}
		rawToken := token[7:]

		idToken, err := auth.oidc.verifier.Verify(r.Context(), rawToken)
		if err != nil && auth.oidc.cliVerifier != nil {
			idToken, err = auth.oidc.cliVerifier.Verify(r.Context(), rawToken)
		}
		if err != nil {
			slog.Warn("tunnel auth failed", "error", err)
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}

		var claims struct {
			Email string `json:"email"`
			Sub   string `json:"sub"`
		}
		if err := idToken.Claims(&claims); err != nil {
			http.Error(w, "failed to parse claims", http.StatusInternalServerError)
			return
		}
		userID := claims.Email
		if userID == "" {
			userID = claims.Sub
		}

		sessionID := r.URL.Query().Get("sessionId")
		if sessionID == "" {
			http.Error(w, "sessionId query param required", http.StatusBadRequest)
			return
		}

		directory := r.URL.Query().Get("directory")

		// Upgrade to WebSocket
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			slog.Error("tunnel upgrade failed", "error", err)
			return
		}

		mux := newMuxConn(ws)

		registry.RegisterTunnel(userID, sessionID, directory, mux)
		slog.Info("tunnel established", "session", sessionID, "user", userID)

		// Block until tunnel closes
		<-mux.closed

		registry.Deregister(sessionID)
		slog.Info("tunnel closed", "session", sessionID, "user", userID)
	}
}
