package main

import (
	"context"
	"testing"
	"time"
)

func TestTunnelRegistryRegisterAndGetTunnel(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	ctx := context.Background()

	tunnel := &muxConn{closed: make(chan struct{})}
	reg.Register(ctx, "alice@example.com", "sess-1", "/project", "10.0.0.1:9090", tunnel)

	got, ok := reg.GetTunnel("sess-1")
	if !ok {
		t.Fatal("expected tunnel to exist")
	}
	if got != tunnel {
		t.Error("expected same tunnel pointer")
	}

	meta, ok := reg.GetMeta(ctx, "sess-1")
	if !ok {
		t.Fatal("expected metadata to exist")
	}
	if meta.TunnelerAddr != "10.0.0.1:9090" {
		t.Errorf("TunnelerAddr = %q, want %q", meta.TunnelerAddr, "10.0.0.1:9090")
	}
}

func TestTunnelRegistryDeregister(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	ctx := context.Background()

	tunnel := &muxConn{closed: make(chan struct{})}
	reg.Register(ctx, "alice@example.com", "sess-1", "/project", "", tunnel)
	reg.Deregister(ctx, "sess-1")

	_, ok := reg.GetTunnel("sess-1")
	if ok {
		t.Fatal("expected tunnel to be gone")
	}
	_, ok = reg.GetMeta(ctx, "sess-1")
	if ok {
		t.Fatal("expected metadata to be gone")
	}
}

func TestTunnelRegistryReRegisterClosesPrevious(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	ctx := context.Background()

	oldTunnel := &muxConn{closed: make(chan struct{})}
	newTunnel := &muxConn{closed: make(chan struct{})}

	reg.Register(ctx, "alice@example.com", "sess-1", "/old", "", oldTunnel)
	reg.Register(ctx, "alice@example.com", "sess-1", "/new", "", newTunnel)

	got, _ := reg.GetTunnel("sess-1")
	if got != newTunnel {
		t.Error("expected new tunnel")
	}

	meta, _ := reg.GetMeta(ctx, "sess-1")
	if meta.Directory != "/new" {
		t.Errorf("Directory = %q, want %q", meta.Directory, "/new")
	}
}

func TestTunnelRegistryRefreshLoopStopsOnCancel(t *testing.T) {
	store := testRedisStore(t)
	reg := NewTunnelRegistry(store)
	ctx, cancel := context.WithCancel(context.Background())

	tunnel := &muxConn{closed: make(chan struct{})}
	reg.Register(ctx, "alice@example.com", "sess-1", "/project", "", tunnel)

	done := make(chan struct{})
	go func() {
		reg.RefreshLoop(ctx, "sess-1", 50*time.Millisecond)
		close(done)
	}()

	cancel()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("refresh loop did not stop after context cancel")
	}
}
