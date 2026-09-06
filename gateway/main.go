// gateway/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"
)

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx := context.Background()
	var oidcProvider *OIDCProvider
	for attempt := 1; attempt <= 30; attempt++ {
		oidcProvider, err = NewOIDCProvider(ctx, cfg)
		if err == nil {
			break
		}
		log.Printf("oidc: attempt %d/30: %v", attempt, err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatalf("oidc: %v", err)
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
	log.Printf("gateway listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
