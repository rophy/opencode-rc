// gateway/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/redis/go-redis/v9"
)

var version = "dev"

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: opencode-rc <gateway|tunneler>\n")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "gateway":
		runGateway()
	case "tunneler":
		runTunneler()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\nUsage: opencode-rc <gateway|tunneler>\n", os.Args[1])
		os.Exit(1)
	}
}

func connectRedis(ctx context.Context, redisURL string) (*redis.Client, SessionStore) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		slog.Error("invalid REDIS_URL", "error", err)
		os.Exit(1)
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		slog.Error("redis connection failed", "error", err)
		os.Exit(1)
	}
	slog.Info("connected to Redis")
	return client, NewRedisStore(client, 1*time.Hour)
}

func runGateway() {
	cfg, err := LoadConfig()
	if err != nil {
		slog.Error("config", "error", err)
		os.Exit(1)
	}

	ctx := context.Background()
	_, store := connectRedis(ctx, cfg.RedisURL)

	var oidcProvider *OIDCProvider
	for attempt := 1; attempt <= 30; attempt++ {
		oidcProvider, err = NewOIDCProvider(ctx, cfg)
		if err == nil {
			break
		}
		slog.Warn("oidc discovery retry", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("oidc discovery failed", "error", err)
		os.Exit(1)
	}

	auth := NewAuth(oidcProvider, cfg.CookieSecret, cfg.CookieDomain, cfg.SecureCookies)

	mux := http.NewServeMux()
	SetupGatewayRoutes(mux, auth, store, cfg.WebUIDir)

	addr := fmt.Sprintf(":%d", cfg.Port)
	slog.Info("gateway starting", "version", version, "addr", addr)
	listenAndServeGraceful(addr, requestLogger(mux))
}

func runTunneler() {
	cfg, err := LoadConfig()
	if err != nil {
		slog.Error("config", "error", err)
		os.Exit(1)
	}

	if cfg.PodIP == "" {
		slog.Error("POD_IP is required for tunneler")
		os.Exit(1)
	}

	ctx := context.Background()
	_, store := connectRedis(ctx, cfg.RedisURL)

	var provider *oidc.Provider
	for attempt := 1; attempt <= 30; attempt++ {
		provider, err = oidc.NewProvider(ctx, cfg.OIDCIssuer)
		if err == nil {
			break
		}
		slog.Warn("oidc discovery retry", "attempt", attempt, "error", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		slog.Error("oidc discovery failed", "error", err)
		os.Exit(1)
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

	addr := fmt.Sprintf(":%d", cfg.Port)
	slog.Info("tunneler starting", "version", version, "addr", addr, "podAddr", podAddr)
	listenAndServeGraceful(addr, requestLogger(mux))
}

func listenAndServeGraceful(addr string, handler http.Handler) {
	srv := &http.Server{Addr: addr, Handler: handler}

	done := make(chan os.Signal, 1)
	signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	<-done
	slog.Info("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown error", "error", err)
	}
}
