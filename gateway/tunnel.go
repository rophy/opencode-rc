package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// TunnelHandler upgrades a CLI connection to a WebSocket tunnel.
// The CLI authenticates with a Bearer token and provides a sessionID.
// The gateway registers the session with the tunnel mux connection.
func TunnelHandler(verifier, cliVerifier TokenVerifier, registry *TunnelRegistry, podAddr string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Validate Bearer token
		token := r.Header.Get("Authorization")
		if len(token) < 8 || token[:7] != "Bearer " {
			http.Error(w, "missing authorization", http.StatusUnauthorized)
			return
		}
		rawToken := token[7:]

		idToken, err := verifier.Verify(r.Context(), rawToken)
		if err != nil && cliVerifier != nil {
			idToken, err = cliVerifier.Verify(r.Context(), rawToken)
		}
		if err != nil {
			slog.Warn("tunnel auth failed", "error", err, "sessionId", r.URL.Query().Get("sessionId"), "remoteAddr", r.RemoteAddr)
			http.Error(w, fmt.Sprintf("invalid token: %v", err), http.StatusUnauthorized)
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

		registry.Register(r.Context(), userID, sessionID, directory, podAddr, mux)
		slog.Info("tunnel established", "session", sessionID, "user", userID)

		refreshCtx, cancelRefresh := context.WithCancel(context.Background())
		go registry.RefreshLoop(refreshCtx, sessionID, 5*time.Minute)

		// Block until tunnel closes
		<-mux.closed

		cancelRefresh()
		registry.Deregister(context.Background(), sessionID)
		slog.Info("tunnel closed", "session", sessionID, "user", userID)
	}
}
