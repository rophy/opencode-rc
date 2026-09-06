package main

import (
	"sync"
	"time"
)

type Session struct {
	ID            string    `json:"id"`
	UserID        string    `json:"userId"`
	Endpoint      string    `json:"endpoint"`
	Directory     string    `json:"directory"`
	LastHeartbeat time.Time `json:"lastHeartbeat"`
	CreatedAt     time.Time `json:"createdAt"`
}

type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session // keyed by session ID
	ttl      time.Duration
}

func NewRegistry(ttl time.Duration) *Registry {
	return &Registry{
		sessions: make(map[string]*Session),
		ttl:      ttl,
	}
}

func (r *Registry) Register(userID, sessionID, endpoint, directory string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.sessions[sessionID] = &Session{
		ID:            sessionID,
		UserID:        userID,
		Endpoint:      endpoint,
		Directory:     directory,
		LastHeartbeat: now,
		CreatedAt:     now,
	}
}

func (r *Registry) Deregister(sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, sessionID)
}

func (r *Registry) Heartbeat(sessionID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[sessionID]
	if !ok {
		return false
	}
	s.LastHeartbeat = time.Now()
	return true
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

func (r *Registry) Reap() {
	r.mu.Lock()
	defer r.mu.Unlock()
	cutoff := time.Now().Add(-r.ttl)
	for id, s := range r.sessions {
		if s.LastHeartbeat.Before(cutoff) {
			delete(r.sessions, id)
		}
	}
}
