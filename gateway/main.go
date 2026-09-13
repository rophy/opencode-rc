// gateway/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"
)

var version = "dev"

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	cfg, err := LoadConfig()
	if err != nil {
		slog.Error("config", "error", err)
		os.Exit(1)
	}

	ctx := context.Background()
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
	registry := NewRegistry(60 * time.Second)

	// Background reaper
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			registry.Reap()
		}
	}()

	mux := http.NewServeMux()
	SetupRoutes(mux, auth, registry, cfg.WebUIDir)

	addr := fmt.Sprintf(":%d", cfg.Port)
	slog.Info("gateway starting", "version", version, "addr", addr)
	if err := http.ListenAndServe(addr, requestLogger(mux)); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}
