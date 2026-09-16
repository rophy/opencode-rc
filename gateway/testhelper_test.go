package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

type mockToken struct {
	claims string
}

func (m *mockToken) Claims(v interface{}) error {
	return json.Unmarshal([]byte(m.claims), v)
}

type badClaimsToken struct{}

func (b *badClaimsToken) Claims(v interface{}) error {
	return errors.New("claims parsing failed")
}

type badClaimsVerifier struct{}

func (b *badClaimsVerifier) Verify(ctx context.Context, rawIDToken string) (ClaimsToken, error) {
	return &badClaimsToken{}, nil
}

type mockVerifier struct {
	claims string
	err    error
}

func (m *mockVerifier) Verify(ctx context.Context, rawIDToken string) (ClaimsToken, error) {
	if m.err != nil {
		return nil, m.err
	}
	return &mockToken{claims: m.claims}, nil
}

func testRedisStore(t *testing.T) SessionStore {
	t.Helper()
	ctx := context.Background()

	container, err := tcredis.Run(ctx, "redis:7-alpine")
	if err != nil {
		t.Fatalf("start redis container: %v", err)
	}
	t.Cleanup(func() {
		container.Terminate(context.Background())
	})

	connStr, err := container.ConnectionString(ctx)
	if err != nil {
		t.Fatalf("get redis connection string: %v", err)
	}

	opt, err := redis.ParseURL(connStr)
	if err != nil {
		t.Fatalf("parse redis url: %v", err)
	}
	client := redis.NewClient(opt)
	t.Cleanup(func() { client.Close() })

	return NewRedisStore(client, 10*time.Minute)
}

func testBrokenStore(t *testing.T) SessionStore {
	t.Helper()
	client := redis.NewClient(&redis.Options{Addr: "localhost:1"}) // port 1 = guaranteed to fail
	return NewRedisStore(client, 10*time.Minute)
}

func testRedisClient(t *testing.T) *redis.Client {
	t.Helper()
	ctx := context.Background()

	container, err := tcredis.Run(ctx, "redis:7-alpine")
	if err != nil {
		t.Fatalf("start redis container: %v", err)
	}
	t.Cleanup(func() {
		container.Terminate(context.Background())
	})

	connStr, err := container.ConnectionString(ctx)
	if err != nil {
		t.Fatalf("get redis connection string: %v", err)
	}

	opt, err := redis.ParseURL(connStr)
	if err != nil {
		t.Fatalf("parse redis url: %v", err)
	}
	client := redis.NewClient(opt)
	t.Cleanup(func() { client.Close() })

	return client
}
