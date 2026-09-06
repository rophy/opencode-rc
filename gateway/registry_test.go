package main

import (
	"testing"
	"time"
)

func TestRegistryRegisterAndLookup(t *testing.T) {
	r := NewRegistry(30 * time.Second)
	r.Register("user1", "sess1", "http://10.0.0.1:4096", "/home/user1/project")

	s, ok := r.Lookup("sess1")
	if !ok {
		t.Fatal("expected session to be found")
	}
	if s.UserID != "user1" {
		t.Errorf("expected UserID=user1, got %s", s.UserID)
	}
	if s.Endpoint != "http://10.0.0.1:4096" {
		t.Errorf("expected Endpoint=http://10.0.0.1:4096, got %s", s.Endpoint)
	}
	if s.Directory != "/home/user1/project" {
		t.Errorf("expected Directory=/home/user1/project, got %s", s.Directory)
	}
}

func TestRegistrySessions(t *testing.T) {
	r := NewRegistry(30 * time.Second)
	r.Register("user1", "sess1", "http://10.0.0.1:4096", "/home/user1/project-a")
	r.Register("user1", "sess2", "http://10.0.0.1:4097", "/home/user1/project-b")
	r.Register("user2", "sess3", "http://10.0.0.2:4096", "/home/user2/project")

	sessions := r.Sessions("user1")
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions for user1, got %d", len(sessions))
	}
}

func TestRegistryDeregister(t *testing.T) {
	r := NewRegistry(30 * time.Second)
	r.Register("user1", "sess1", "http://10.0.0.1:4096", "/proj")
	r.Deregister("sess1")

	_, ok := r.Lookup("sess1")
	if ok {
		t.Fatal("expected session to be gone after deregister")
	}
}

func TestRegistryHeartbeat(t *testing.T) {
	r := NewRegistry(30 * time.Second)
	r.Register("user1", "sess1", "http://10.0.0.1:4096", "/proj")

	if !r.Heartbeat("sess1") {
		t.Fatal("expected heartbeat to succeed")
	}
	if r.Heartbeat("nonexistent") {
		t.Fatal("expected heartbeat for nonexistent session to fail")
	}
}

func TestRegistryReap(t *testing.T) {
	r := NewRegistry(1 * time.Millisecond)
	r.Register("user1", "sess1", "http://10.0.0.1:4096", "/proj")

	time.Sleep(5 * time.Millisecond)
	r.Reap()

	_, ok := r.Lookup("sess1")
	if ok {
		t.Fatal("expected session to be reaped after TTL")
	}
}
