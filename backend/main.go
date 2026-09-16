package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/redis/go-redis/v9"
	"golang.org/x/oauth2"
)

var version = "dev"

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	if len(os.Args) < 2 || os.Args[1] != "tunneler" {
		fmt.Fprintf(os.Stderr, "Usage: opencode-rc tunneler\n")
		os.Exit(1)
	}

	if err := runTunneler(); err != nil {
		slog.Error("fatal", "error", err)
		os.Exit(1)
	}
}

func contextWithTLS(ctx context.Context, insecure bool) context.Context {
	if !insecure {
		return ctx
	}
	slog.Warn("TLS certificate verification disabled")
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	client := &http.Client{Transport: transport}
	ctx = oidc.ClientContext(ctx, client)
	ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
	return ctx
}

func connectRedis(ctx context.Context, redisURL string) (*redis.Client, SessionStore, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid REDIS_URL: %w", err)
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		client.Close()
		return nil, nil, fmt.Errorf("redis connection failed: %w", err)
	}
	slog.Info("connected to Redis")
	return client, NewRedisStore(client, 1*time.Hour), nil
}

func discoverOIDC(ctx context.Context, issuer string, maxRetries int) (*oidc.Provider, error) {
	var err error
	var provider *oidc.Provider
	for attempt := 1; attempt <= maxRetries; attempt++ {
		provider, err = oidc.NewProvider(ctx, issuer)
		if err == nil {
			return provider, nil
		}
		if attempt < maxRetries {
			slog.Warn("oidc discovery retry", "attempt", attempt, "error", err)
			time.Sleep(2 * time.Second)
		}
	}
	return nil, fmt.Errorf("oidc discovery failed after %d attempts: %w", maxRetries, err)
}

var oidcMaxRetries = 30

func setupTunneler(ctx context.Context, cfg *Config) (http.Handler, error) {
	if cfg.PodIP == "" {
		return nil, fmt.Errorf("POD_IP is required for tunneler")
	}

	_, store, err := connectRedis(ctx, cfg.RedisURL)
	if err != nil {
		return nil, err
	}

	provider, err := discoverOIDC(ctx, cfg.OIDCIssuer, oidcMaxRetries)
	if err != nil {
		return nil, err
	}

	verifier := idTokenVerifier{provider.Verifier(&oidc.Config{ClientID: cfg.OIDCClientID})}
	var cliVerifier TokenVerifier
	if cfg.OIDCCLIClientID != "" {
		cliVerifier = idTokenVerifier{provider.Verifier(&oidc.Config{ClientID: cfg.OIDCCLIClientID})}
	}

	podAddr := fmt.Sprintf("%s:%d", cfg.PodIP, cfg.Port)
	registry := NewTunnelRegistry(store)

	mux := http.NewServeMux()
	SetupTunnelerRoutes(mux, verifier, cliVerifier, registry, podAddr)
	return requestLogger(mux), nil
}

func runTunneler() error {
	cfg, err := LoadConfig()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	ctx := contextWithTLS(context.Background(), cfg.TLSInsecureSkipVerify)
	handler, err := setupTunneler(ctx, cfg)
	if err != nil {
		return err
	}

	addr := fmt.Sprintf(":%d", cfg.Port)
	slog.Info("tunneler starting", "version", version, "addr", addr)
	return listenAndServeGraceful(addr, handler, nil)
}

func listenAndServeGraceful(addr string, handler http.Handler, ln net.Listener) error {
	srv := &http.Server{Addr: addr, Handler: handler}

	done := make(chan os.Signal, 1)
	signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)

	listenErr := make(chan error, 1)
	if ln != nil {
		go func() {
			listenErr <- srv.Serve(ln)
		}()
	} else {
		go func() {
			listenErr <- srv.ListenAndServe()
		}()
	}

	select {
	case <-done:
		slog.Info("shutting down")
	case err := <-listenErr:
		if err != nil && err != http.ErrServerClosed {
			return fmt.Errorf("server error: %w", err)
		}
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("shutdown error: %w", err)
	}
	return nil
}
