package main

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestRedisStorePutGet(t *testing.T) {
	store := testRedisStore(t)
	ctx := context.Background()

	meta := SessionMeta{
		ID:           "sess-1",
		UserID:       "alice@example.com",
		Directory:    "/home/alice/project",
		TunnelerAddr: "10.0.0.1:9090",
		CreatedAt:    time.Now().Truncate(time.Millisecond),
	}

	if err := store.Put(ctx, meta); err != nil {
		t.Fatal(err)
	}

	got, ok, err := store.Get(ctx, "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected session to exist")
	}
	if got.UserID != "alice@example.com" {
		t.Errorf("UserID = %q, want %q", got.UserID, "alice@example.com")
	}
	if got.TunnelerAddr != "10.0.0.1:9090" {
		t.Errorf("TunnelerAddr = %q, want %q", got.TunnelerAddr, "10.0.0.1:9090")
	}
}

func TestRedisStoreGetMissing(t *testing.T) {
	store := testRedisStore(t)
	_, ok, err := store.Get(context.Background(), "nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected session to not exist")
	}
}

func TestRedisStoreDelete(t *testing.T) {
	store := testRedisStore(t)
	ctx := context.Background()

	store.Put(ctx, SessionMeta{ID: "sess-1", UserID: "alice@example.com"})
	if err := store.Delete(ctx, "sess-1"); err != nil {
		t.Fatal(err)
	}

	_, ok, _ := store.Get(ctx, "sess-1")
	if ok {
		t.Fatal("expected session to be deleted")
	}
}

func TestRedisStoreList(t *testing.T) {
	store := testRedisStore(t)
	ctx := context.Background()

	store.Put(ctx, SessionMeta{ID: "sess-1", UserID: "alice@example.com"})
	store.Put(ctx, SessionMeta{ID: "sess-2", UserID: "alice@example.com"})
	store.Put(ctx, SessionMeta{ID: "sess-3", UserID: "bob@example.com"})

	sessions, err := store.List(ctx, "alice@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Errorf("got %d sessions, want 2", len(sessions))
	}
}

func TestRedisStorePutOverwrite(t *testing.T) {
	store := testRedisStore(t)
	ctx := context.Background()

	store.Put(ctx, SessionMeta{ID: "sess-1", UserID: "alice@example.com", Directory: "/old"})
	store.Put(ctx, SessionMeta{ID: "sess-1", UserID: "alice@example.com", Directory: "/new"})

	got, _, _ := store.Get(ctx, "sess-1")
	if got.Directory != "/new" {
		t.Errorf("Directory = %q, want %q", got.Directory, "/new")
	}
}

func TestRedisStoreTTL(t *testing.T) {
	client := testRedisClient(t)
	store := NewRedisStore(client, 1*time.Second)
	ctx := context.Background()

	store.Put(ctx, SessionMeta{ID: "sess-ttl", UserID: "alice@example.com"})
	_, ok, _ := store.Get(ctx, "sess-ttl")
	if !ok {
		t.Fatal("expected session to exist before TTL")
	}

	time.Sleep(1500 * time.Millisecond)

	_, ok, _ = store.Get(ctx, "sess-ttl")
	if ok {
		t.Fatal("expected session to be expired after TTL")
	}
}

func TestRedisStorePutRefreshesTTL(t *testing.T) {
	client := testRedisClient(t)
	store := NewRedisStore(client, 2*time.Second)
	ctx := context.Background()

	store.Put(ctx, SessionMeta{ID: "sess-refresh", UserID: "alice@example.com"})
	time.Sleep(1 * time.Second)

	store.Put(ctx, SessionMeta{ID: "sess-refresh", UserID: "alice@example.com"})
	time.Sleep(1500 * time.Millisecond)

	_, ok, _ := store.Get(ctx, "sess-refresh")
	if !ok {
		t.Fatal("expected session to still exist after TTL refresh")
	}
}

func TestRedisStorePing(t *testing.T) {
	store := testRedisStore(t)
	if err := store.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRedisStoreGetCorruptData(t *testing.T) {
	client := testRedisClient(t)
	store := NewRedisStore(client, 10*time.Minute)
	ctx := context.Background()

	// Put corrupt data directly into Redis
	client.Set(ctx, "orc:session:corrupt-sess", "not-valid-json{{{", 10*time.Minute)

	_, _, err := store.Get(ctx, "corrupt-sess")
	if err == nil {
		t.Fatal("expected error for corrupt session data")
	}
}

func TestRedisStoreListWithCorruptEntry(t *testing.T) {
	client := testRedisClient(t)
	store := NewRedisStore(client, 10*time.Minute)
	ctx := context.Background()

	// Add a valid session
	store.Put(ctx, SessionMeta{ID: "good-sess", UserID: "alice@example.com"})

	// Corrupt one entry directly
	client.Set(ctx, "orc:session:bad-sess", "not-json{{{", 10*time.Minute)
	client.SAdd(ctx, "orc:user-sessions:alice@example.com", "bad-sess")

	sessions, err := store.List(ctx, "alice@example.com")
	if err != nil {
		t.Fatal(err)
	}
	// Should only return the good session (corrupt one is skipped)
	if len(sessions) != 1 {
		t.Errorf("expected 1 valid session, got %d", len(sessions))
	}
}

func TestRedisStoreBrokenConnection(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "localhost:1"})
	store := NewRedisStore(client, 10*time.Minute)
	ctx := context.Background()

	if err := store.Put(ctx, SessionMeta{ID: "s1", UserID: "u1"}); err == nil {
		t.Error("expected error from Put on broken connection")
	}
	if _, _, err := store.Get(ctx, "s1"); err == nil {
		t.Error("expected error from Get on broken connection")
	}
	if err := store.Delete(ctx, "s1"); err == nil {
		t.Error("expected error from Delete on broken connection")
	}
	if _, err := store.List(ctx, "u1"); err == nil {
		t.Error("expected error from List on broken connection")
	}
}

func TestRedisStoreListCleansStaleIDs(t *testing.T) {
	client := testRedisClient(t)
	store := NewRedisStore(client, 10*time.Minute)
	ctx := context.Background()

	store.Put(ctx, SessionMeta{ID: "sess-1", UserID: "alice@example.com"})
	store.Put(ctx, SessionMeta{ID: "sess-2", UserID: "alice@example.com"})

	client.Del(ctx, "orc:session:sess-2")

	sessions, err := store.List(ctx, "alice@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 {
		t.Errorf("got %d sessions, want 1 (stale cleaned)", len(sessions))
	}

	members, _ := client.SMembers(ctx, "orc:user-sessions:alice@example.com").Result()
	if len(members) != 1 {
		t.Errorf("stale ID not cleaned from set: got %d members", len(members))
	}
}
