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
func TunnelHandler(verifier, cliVerifier TokenVerifier, registry *TunnelRegistry, podAddr, userClaim string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !checkCLIProtocol(w, r) {
			return
		}

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

		var claims map[string]any
		if err := idToken.Claims(&claims); err != nil {
			http.Error(w, "failed to parse claims", http.StatusInternalServerError)
			return
		}
		// Sessions are owned by an IdP-assigned ID; the email is only for logs.
		userID, _ := claims[userClaim].(string)
		email, _ := claims["email"].(string)
		if userID == "" {
			slog.Warn("tunnel auth failed", "error", "missing user claim", "claim", userClaim, "email", email)
			http.Error(w, fmt.Sprintf("token has no %s claim", userClaim), http.StatusUnauthorized)
			return
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

		if err := registry.Register(r.Context(), userID, email, sessionID, directory, podAddr, mux); err != nil {
			slog.Warn("tunnel registration rejected", "session", sessionID, "user", userID, "email", email, "error", err)
			ws.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session owned by another user"))
			ws.Close()
			return
		}
		slog.Info("tunnel established", "session", sessionID, "user", userID, "email", email)

		refreshCtx, cancelRefresh := context.WithCancel(context.Background())
		go registry.RefreshLoop(refreshCtx, sessionID, 5*time.Minute)

		// Block until tunnel closes
		<-mux.closed

		cancelRefresh()
		registry.Deregister(context.Background(), sessionID, mux)
		slog.Info("tunnel closed", "session", sessionID, "user", userID, "email", email)
	}
}
