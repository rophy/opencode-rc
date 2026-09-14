package main

import (
	"log/slog"
	"sync"
	"time"
)

type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	Directory string    `json:"directory"`
	CreatedAt time.Time `json:"createdAt"`
	Tunnel    *muxConn  `json:"-"`
}

type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session // keyed by session ID
}

func NewRegistry() *Registry {
	return &Registry{
		sessions: make(map[string]*Session),
	}
}

func (r *Registry) RegisterTunnel(userID, sessionID, directory string, tunnel *muxConn) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Close existing tunnel if re-registering
	if old, ok := r.sessions[sessionID]; ok && old.Tunnel != nil {
		old.Tunnel.close()
	}

	r.sessions[sessionID] = &Session{
		ID:        sessionID,
		UserID:    userID,
		Directory: directory,
		CreatedAt: time.Now(),
		Tunnel:    tunnel,
	}
	slog.Info("session registered", "session", sessionID, "user", userID)
}

func (r *Registry) Deregister(sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.sessions[sessionID]; ok {
		slog.Info("session deregistered", "session", sessionID, "user", s.UserID)
	}
	delete(r.sessions, sessionID)
}

func (r *Registry) Sessions(userID string) []Session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var result []Session
	for _, s := range r.sessions {
		if s.UserID == userID {
			result = append(result, *s)
		}
	}
	return result
}

func (r *Registry) Lookup(sessionID string) (*Session, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.sessions[sessionID]
	if !ok {
		return nil, false
	}
	return s, true
}
