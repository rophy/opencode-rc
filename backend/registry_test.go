package main

import (
	"testing"
)

func TestRegistryRegisterTunnelAndLookup(t *testing.T) {
	r := NewRegistry()
	r.RegisterTunnel("user1", "sess1", "/home/user1/project", nil)

	s, ok := r.Lookup("sess1")
	if !ok {
		t.Fatal("expected session to be found")
	}
	if s.UserID != "user1" {
		t.Errorf("expected UserID=user1, got %s", s.UserID)
	}
	if s.Directory != "/home/user1/project" {
		t.Errorf("expected Directory=/home/user1/project, got %s", s.Directory)
	}
}

func TestRegistrySessions(t *testing.T) {
	r := NewRegistry()
	r.RegisterTunnel("user1", "sess1", "/home/user1/project-a", nil)
	r.RegisterTunnel("user1", "sess2", "/home/user1/project-b", nil)
	r.RegisterTunnel("user2", "sess3", "/home/user2/project", nil)

	sessions := r.Sessions("user1")
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions for user1, got %d", len(sessions))
	}
}

func TestRegistryDeregister(t *testing.T) {
	r := NewRegistry()
	r.RegisterTunnel("user1", "sess1", "/proj", nil)
	r.Deregister("sess1")

	_, ok := r.Lookup("sess1")
	if ok {
		t.Fatal("expected session to be gone after deregister")
	}
}

func TestRegistryReRegisterClosesPrevious(t *testing.T) {
	r := NewRegistry()
	r.RegisterTunnel("user1", "sess1", "/proj-v1", nil)
	r.RegisterTunnel("user1", "sess1", "/proj-v2", nil)

	s, ok := r.Lookup("sess1")
	if !ok {
		t.Fatal("expected session to be found")
	}
	if s.Directory != "/proj-v2" {
		t.Errorf("expected updated directory, got %s", s.Directory)
	}
}
