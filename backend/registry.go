package main

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

type TunnelRegistry struct {
	store   SessionStore
	tunnels sync.Map // sessionID → *muxConn
}

func NewTunnelRegistry(store SessionStore) *TunnelRegistry {
	return &TunnelRegistry{store: store}
}

func (r *TunnelRegistry) Register(ctx context.Context, userID, sessionID, directory, podAddr string, tunnel *muxConn) {
	if old, ok := r.tunnels.Load(sessionID); ok && old != nil {
		old.(*muxConn).close()
	}

	meta := SessionMeta{
		ID:           sessionID,
		UserID:       userID,
		Directory:    directory,
		TunnelerAddr: podAddr,
		CreatedAt:    time.Now(),
	}
	if err := r.store.Put(ctx, meta); err != nil {
		slog.Error("failed to register session", "session", sessionID, "error", err)
	}

	r.tunnels.Store(sessionID, tunnel)
	slog.Info("session registered", "session", sessionID, "user", userID, "addr", podAddr)
}

func (r *TunnelRegistry) Deregister(ctx context.Context, sessionID string) {
	r.tunnels.Delete(sessionID)
	if err := r.store.Delete(ctx, sessionID); err != nil {
		slog.Error("failed to deregister session", "session", sessionID, "error", err)
	}
	slog.Info("session deregistered", "session", sessionID)
}

func (r *TunnelRegistry) GetTunnel(sessionID string) (*muxConn, bool) {
	t, ok := r.tunnels.Load(sessionID)
	if !ok {
		return nil, false
	}
	return t.(*muxConn), true
}

func (r *TunnelRegistry) GetMeta(ctx context.Context, sessionID string) (SessionMeta, bool) {
	meta, ok, err := r.store.Get(ctx, sessionID)
	if err != nil {
		slog.Error("failed to lookup session", "session", sessionID, "error", err)
		return SessionMeta{}, false
	}
	return meta, ok
}

func (r *TunnelRegistry) RefreshLoop(ctx context.Context, sessionID string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			meta, ok, err := r.store.Get(ctx, sessionID)
			if err != nil || !ok {
				return
			}
			if err := r.store.Put(ctx, meta); err != nil {
				slog.Warn("session refresh failed", "session", sessionID, "error", err)
			}
		}
	}
}
