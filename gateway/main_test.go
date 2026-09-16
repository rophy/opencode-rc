package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestContextWithTLSInsecure(t *testing.T) {
	ctx := contextWithTLS(context.Background(), true)
	if ctx == nil {
		t.Fatal("expected non-nil context")
	}
	if ctx == context.Background() {
		t.Error("expected different context when insecure=true")
	}
}

func TestContextWithTLSSecure(t *testing.T) {
	ctx := contextWithTLS(context.Background(), false)
	if ctx != context.Background() {
		t.Error("expected same context when insecure=false")
	}
}

func TestConnectRedis(t *testing.T) {
	client := testRedisClient(t)
	addr := client.Options().Addr
	client.Close()

	redisURL := fmt.Sprintf("redis://%s", addr)
	rc, store, err := connectRedis(context.Background(), redisURL)
	if err != nil {
		t.Fatalf("connectRedis failed: %v", err)
	}
	defer rc.Close()
	if store == nil {
		t.Fatal("expected non-nil store")
	}
}

func TestConnectRedisInvalidURL(t *testing.T) {
	_, _, err := connectRedis(context.Background(), "not-a-url")
	if err == nil {
		t.Fatal("expected error for invalid URL")
	}
}

func TestConnectRedisUnreachable(t *testing.T) {
	_, _, err := connectRedis(context.Background(), "redis://127.0.0.1:1")
	if err == nil {
		t.Fatal("expected error for unreachable Redis")
	}
}

func TestDiscoverOIDC(t *testing.T) {
	srv := mockOIDCServer(t)
	defer srv.Close()

	provider, err := discoverOIDC(context.Background(), srv.URL, 1)
	if err != nil {
		t.Fatalf("discoverOIDC failed: %v", err)
	}
	if provider == nil {
		t.Fatal("expected non-nil provider")
	}
}

func TestDiscoverOIDCUnreachable(t *testing.T) {
	_, err := discoverOIDC(context.Background(), "http://127.0.0.1:1", 1)
	if err == nil {
		t.Fatal("expected error for unreachable issuer")
	}
}

func testConfig(t *testing.T, redisURL, oidcIssuer string) *Config {
	t.Helper()
	secret := make([]byte, 32)
	for i := range secret {
		secret[i] = byte(i)
	}
	return &Config{
		Port:             8080,
		OIDCIssuer:       oidcIssuer,
		OIDCClientID:     "test-client",
		OIDCClientSecret: "test-secret",
		OIDCRedirectURI:  "http://localhost/callback",
		CookieSecret:     secret,
		RedisURL:         redisURL,
		PodIP:            "10.0.0.1",
	}
}

func TestSetupGateway(t *testing.T) {
	old := oidcMaxRetries
	oidcMaxRetries = 1
	defer func() { oidcMaxRetries = old }()

	oidcSrv := mockOIDCServer(t)
	defer oidcSrv.Close()

	redisClient := testRedisClient(t)
	redisURL := fmt.Sprintf("redis://%s", redisClient.Options().Addr)
	redisClient.Close()

	cfg := testConfig(t, redisURL, oidcSrv.URL)
	cfg.PodIP = "10.0.0.1"

	handler, err := setupGateway(context.Background(), cfg)
	if err != nil {
		t.Fatalf("setupGateway failed: %v", err)
	}
	if handler == nil {
		t.Fatal("expected non-nil handler")
	}
}

func TestSetupGatewayWithCLIClient(t *testing.T) {
	old := oidcMaxRetries
	oidcMaxRetries = 1
	defer func() { oidcMaxRetries = old }()

	oidcSrv := mockOIDCServer(t)
	defer oidcSrv.Close()

	redisClient := testRedisClient(t)
	redisURL := fmt.Sprintf("redis://%s", redisClient.Options().Addr)
	redisClient.Close()

	cfg := testConfig(t, redisURL, oidcSrv.URL)
	cfg.PodIP = "10.0.0.1"
	cfg.OIDCCLIClientID = "cli-client"

	handler, err := setupGateway(context.Background(), cfg)
	if err != nil {
		t.Fatalf("setupGateway failed: %v", err)
	}
	if handler == nil {
		t.Fatal("expected non-nil handler")
	}
}

func TestSetupGatewayMissingPodIP(t *testing.T) {
	cfg := testConfig(t, "redis://localhost:6379", "http://localhost")
	cfg.PodIP = ""

	_, err := setupGateway(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected error for missing PodIP")
	}
}

func TestSetupGatewayBadRedis(t *testing.T) {
	cfg := testConfig(t, "redis://127.0.0.1:1", "http://localhost")

	_, err := setupGateway(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected error for unreachable Redis")
	}
}

func TestSetupGatewayBadOIDC(t *testing.T) {
	old := oidcMaxRetries
	oidcMaxRetries = 1
	defer func() { oidcMaxRetries = old }()

	redisClient := testRedisClient(t)
	redisURL := fmt.Sprintf("redis://%s", redisClient.Options().Addr)
	redisClient.Close()

	cfg := testConfig(t, redisURL, "http://127.0.0.1:1")

	_, err := setupGateway(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected error for unreachable OIDC")
	}
}

func TestRunGatewayBadConfig(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "")
	err := runGateway()
	if err == nil {
		t.Fatal("expected error for bad config")
	}
}

func TestRunGatewayBadRedis(t *testing.T) {
	old := oidcMaxRetries
	oidcMaxRetries = 1
	defer func() { oidcMaxRetries = old }()

	t.Setenv("OIDC_ISSUER", "http://127.0.0.1:1")
	t.Setenv("OIDC_CLIENT_ID", "test")
	t.Setenv("OIDC_REDIRECT_URI", "http://localhost/callback")
	t.Setenv("COOKIE_SECRET", hex.EncodeToString(make([]byte, 32)))
	t.Setenv("REDIS_URL", "redis://127.0.0.1:1")
	t.Setenv("POD_IP", "10.0.0.1")

	err := runGateway()
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestListenAndServeGraceful(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	errCh := make(chan error, 1)
	go func() {
		errCh <- listenAndServeGraceful(ln.Addr().String(), handler, ln)
	}()

	time.Sleep(50 * time.Millisecond)

	resp, err := http.Get(fmt.Sprintf("http://%s/", ln.Addr().String()))
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	p, _ := os.FindProcess(os.Getpid())
	p.Signal(syscall.SIGINT)

	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not shut down")
	}
}

func TestListenAndServeGracefulBadAddr(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	err := listenAndServeGraceful("127.0.0.1:-1", handler, nil)
	if err == nil {
		t.Fatal("expected error for invalid address")
	}
}
