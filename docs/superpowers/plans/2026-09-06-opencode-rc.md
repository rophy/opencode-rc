# opencode-rc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a remote control system for OpenCode that lets developers expose their local `opencode serve` instances through a centrally managed Go gateway with corporate OIDC authentication.

**Architecture:** Two components — a Go gateway that authenticates browser users via OIDC, maintains a session registry, reverse-proxies HTTP/SSE/WebSocket to dev machines, and serves the OpenCode web UI as static files; and a Node CLI that developers run on their machines to start `opencode serve`, authenticate via OIDC device flow, and register with the gateway. The web app uses `location.origin` as API base in production, so serving it from the gateway and proxying `/api/*` to dev machines works without modification.

**Tech Stack:** Go 1.22+ (stdlib `net/http`, `httputil.ReverseProxy`), Node.js + TypeScript (`@opencode-ai/sdk`), OIDC (`coreos/go-oidc` + `golang.org/x/oauth2`), SolidJS web app (pre-built static files from `@opencode-ai/app`)

**Spec:** `DESIGN.md`

## Global Constraints

- Go gateway must handle 5K+ concurrent dev machine connections (SSE heartbeats, HTTP proxying)
- All OIDC configuration via environment variables (issuer URL, client ID, client secret, redirect URI)
- Gateway and dev machines on the same corporate network (gateway can reach dev machines directly)
- V2 API protocol only (`/api/*` prefix) — no need to support legacy v1
- No modification to the OpenCode web app source — serve pre-built static files as-is
- The gateway must proxy three transport types: regular HTTP, SSE (long-lived streaming), and WebSocket (PTY)
- Session registry is in-memory (single gateway instance); shared storage (Redis) is a future concern

---

## File Structure

### Go Gateway (`gateway/`)

```
gateway/
├── go.mod
├── go.sum
├── main.go                    # entry point, config loading, server startup
├── config.go                  # configuration struct + env var parsing
├── oidc.go                    # OIDC provider setup, token validation
├── auth.go                    # auth middleware, session cookie management
├── registry.go                # session registry (register, deregister, heartbeat, lookup)
├── proxy.go                   # reverse proxy handler (HTTP, SSE, WebSocket)
├── dashboard.go               # dashboard API + HTML handler
├── routes.go                  # route wiring
├── webui.go                   # static file serving for OpenCode web app
├── registry_test.go           # registry unit tests
├── proxy_test.go              # proxy integration tests
├── auth_test.go               # auth middleware tests
└── dashboard_test.go          # dashboard tests
```

### Node CLI (`cli/`)

```
cli/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts               # entry point, CLI argument parsing
│   ├── oidc.ts                # OIDC device flow authentication
│   ├── server.ts              # start opencode serve via SDK
│   ├── register.ts            # register with gateway + heartbeat loop
│   └── config.ts              # configuration (gateway URL, OIDC settings)
└── test/
    ├── oidc.test.ts
    └── register.test.ts
```

---

## Task 1: Go Gateway — Project Scaffolding and Configuration

**Files:**
- Create: `gateway/go.mod`
- Create: `gateway/main.go`
- Create: `gateway/config.go`

**Interfaces:**
- Produces: `Config` struct with fields `Port int`, `OIDCIssuer string`, `OIDCClientID string`, `OIDCClientSecret string`, `OIDCRedirectURI string`, `WebUIDir string`, `CookieSecret []byte`, `CookieDomain string`
- Produces: `LoadConfig() (*Config, error)` — reads from env vars

- [ ] **Step 1: Initialize Go module**

```bash
cd gateway
go mod init github.com/rophy/opencode-rc/gateway
```

- [ ] **Step 2: Write config.go**

```go
// gateway/config.go
package main

import (
	"encoding/hex"
	"errors"
	"os"
	"strconv"
)

type Config struct {
	Port            int
	OIDCIssuer      string
	OIDCClientID    string
	OIDCClientSecret string
	OIDCRedirectURI string
	WebUIDir        string
	CookieSecret    []byte
	CookieDomain    string
}

func LoadConfig() (*Config, error) {
	port := 8080
	if v := os.Getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil {
			return nil, errors.New("PORT must be an integer")
		}
		port = p
	}

	issuer := os.Getenv("OIDC_ISSUER")
	if issuer == "" {
		return nil, errors.New("OIDC_ISSUER is required")
	}
	clientID := os.Getenv("OIDC_CLIENT_ID")
	if clientID == "" {
		return nil, errors.New("OIDC_CLIENT_ID is required")
	}
	clientSecret := os.Getenv("OIDC_CLIENT_SECRET")
	redirectURI := os.Getenv("OIDC_REDIRECT_URI")
	if redirectURI == "" {
		return nil, errors.New("OIDC_REDIRECT_URI is required")
	}

	secretHex := os.Getenv("COOKIE_SECRET")
	if secretHex == "" {
		return nil, errors.New("COOKIE_SECRET is required (32-byte hex string)")
	}
	secret, err := hex.DecodeString(secretHex)
	if err != nil || len(secret) != 32 {
		return nil, errors.New("COOKIE_SECRET must be a 64-char hex string (32 bytes)")
	}

	webUIDir := os.Getenv("WEBUI_DIR")

	return &Config{
		Port:            port,
		OIDCIssuer:      issuer,
		OIDCClientID:    clientID,
		OIDCClientSecret: clientSecret,
		OIDCRedirectURI: redirectURI,
		WebUIDir:        webUIDir,
		CookieSecret:    secret,
		CookieDomain:    os.Getenv("COOKIE_DOMAIN"),
	}, nil
}
```

- [ ] **Step 3: Write minimal main.go**

```go
// gateway/main.go
package main

import (
	"fmt"
	"log"
	"net/http"
)

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("gateway listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd gateway && go build ./...
```

- [ ] **Step 5: Commit**

```bash
git add gateway/
git commit -m "feat: gateway scaffolding with config and health endpoint"
```

---

## Task 2: Go Gateway — Session Registry

**Files:**
- Create: `gateway/registry.go`
- Create: `gateway/registry_test.go`

**Interfaces:**
- Produces: `Registry` struct with methods:
  - `Register(userID, sessionID, endpoint string)` — adds a session
  - `Deregister(sessionID string)` — removes a session
  - `Heartbeat(sessionID string) bool` — refreshes TTL, returns false if not found
  - `Sessions(userID string) []Session` — lists user's active sessions
  - `Lookup(sessionID string) (*Session, bool)` — finds a session by ID
  - `Reap()` — removes expired sessions
- Produces: `Session` struct with fields `ID`, `UserID`, `Endpoint`, `LastHeartbeat`, `Directory`, `CreatedAt`

- [ ] **Step 1: Write the failing test**

```go
// gateway/registry_test.go
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd gateway && go test -run TestRegistry -v
```

Expected: compilation error — `NewRegistry` not defined.

- [ ] **Step 3: Implement registry.go**

```go
// gateway/registry.go
package main

import (
	"sync"
	"time"
)

type Session struct {
	ID            string    `json:"id"`
	UserID        string    `json:"userId"`
	Endpoint      string    `json:"endpoint"`
	Directory     string    `json:"directory"`
	LastHeartbeat time.Time `json:"lastHeartbeat"`
	CreatedAt     time.Time `json:"createdAt"`
}

type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session // keyed by session ID
	ttl      time.Duration
}

func NewRegistry(ttl time.Duration) *Registry {
	return &Registry{
		sessions: make(map[string]*Session),
		ttl:      ttl,
	}
}

func (r *Registry) Register(userID, sessionID, endpoint, directory string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.sessions[sessionID] = &Session{
		ID:            sessionID,
		UserID:        userID,
		Endpoint:      endpoint,
		Directory:     directory,
		LastHeartbeat: now,
		CreatedAt:     now,
	}
}

func (r *Registry) Deregister(sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, sessionID)
}

func (r *Registry) Heartbeat(sessionID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[sessionID]
	if !ok {
		return false
	}
	s.LastHeartbeat = time.Now()
	return true
}

func (r *Registry) Sessions(userID string) []Session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var result []Session
	for _, s := range r.sessions {
		if s.UserID == userID {
			result = append(result, *s)
		}
	}
	return result
}

func (r *Registry) Lookup(sessionID string) (*Session, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.sessions[sessionID]
	if !ok {
		return nil, false
	}
	return s, true
}

func (r *Registry) Reap() {
	r.mu.Lock()
	defer r.mu.Unlock()
	cutoff := time.Now().Add(-r.ttl)
	for id, s := range r.sessions {
		if s.LastHeartbeat.Before(cutoff) {
			delete(r.sessions, id)
		}
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd gateway && go test -run TestRegistry -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/registry.go gateway/registry_test.go
git commit -m "feat: in-memory session registry with TTL-based reaping"
```

---

## Task 3: Go Gateway — OIDC Authentication

**Files:**
- Create: `gateway/oidc.go`
- Create: `gateway/auth.go`
- Create: `gateway/auth_test.go`

**Interfaces:**
- Consumes: `Config` from Task 1
- Produces: `OIDCProvider` struct with method `Verifier() *oidc.IDTokenVerifier`
- Produces: `NewOIDCProvider(ctx context.Context, cfg *Config) (*OIDCProvider, error)`
- Produces: `AuthMiddleware` — `func(next http.Handler) http.Handler` that validates session cookies
- Produces: `LoginHandler(w, r)` — redirects to OIDC provider
- Produces: `CallbackHandler(w, r)` — handles OIDC callback, sets encrypted session cookie
- Produces: `UserFromContext(ctx context.Context) string` — extracts user ID from request context

- [ ] **Step 1: Add OIDC dependencies**

```bash
cd gateway
go get github.com/coreos/go-oidc/v3@latest
go get golang.org/x/oauth2@latest
go get github.com/gorilla/securecookie@latest
```

- [ ] **Step 2: Write oidc.go**

```go
// gateway/oidc.go
package main

import (
	"context"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type OIDCProvider struct {
	provider     *oidc.Provider
	oauth2Config oauth2.Config
	verifier     *oidc.IDTokenVerifier
}

func NewOIDCProvider(ctx context.Context, cfg *Config) (*OIDCProvider, error) {
	provider, err := oidc.NewProvider(ctx, cfg.OIDCIssuer)
	if err != nil {
		return nil, err
	}

	oauth2Config := oauth2.Config{
		ClientID:     cfg.OIDCClientID,
		ClientSecret: cfg.OIDCClientSecret,
		RedirectURL:  cfg.OIDCRedirectURI,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
	}

	verifier := provider.Verifier(&oidc.Config{ClientID: cfg.OIDCClientID})

	return &OIDCProvider{
		provider:     provider,
		oauth2Config: oauth2Config,
		verifier:     verifier,
	}, nil
}
```

- [ ] **Step 3: Write auth.go**

```go
// gateway/auth.go
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/securecookie"
)

type contextKey string

const userContextKey contextKey = "user"

type sessionData struct {
	UserID string `json:"uid"`
	Email  string `json:"email"`
	Expiry int64  `json:"exp"`
}

type Auth struct {
	oidc   *OIDCProvider
	cookie *securecookie.SecureCookie
	domain string
}

func NewAuth(oidc *OIDCProvider, cookieSecret []byte, domain string) *Auth {
	sc := securecookie.New(cookieSecret, nil)
	sc.MaxAge(86400)
	return &Auth{oidc: oidc, cookie: sc, domain: domain}
}

func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("orc_session")
		if err != nil {
			http.Redirect(w, r, "/auth/login", http.StatusFound)
			return
		}

		var data sessionData
		if err := a.cookie.Decode("orc_session", c.Value, &data); err != nil {
			http.Redirect(w, r, "/auth/login", http.StatusFound)
			return
		}

		if time.Now().Unix() > data.Expiry {
			http.Redirect(w, r, "/auth/login", http.StatusFound)
			return
		}

		ctx := context.WithValue(r.Context(), userContextKey, data.UserID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (a *Auth) LoginHandler(w http.ResponseWriter, r *http.Request) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	state := hex.EncodeToString(b)

	http.SetCookie(w, &http.Cookie{
		Name:     "orc_state",
		Value:    state,
		Path:     "/auth",
		MaxAge:   300,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   true,
	})

	http.Redirect(w, r, a.oidc.oauth2Config.AuthCodeURL(state), http.StatusFound)
}

func (a *Auth) CallbackHandler(w http.ResponseWriter, r *http.Request) {
	stateCookie, err := r.Cookie("orc_state")
	if err != nil || stateCookie.Value != r.URL.Query().Get("state") {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}

	token, err := a.oidc.oauth2Config.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		log.Printf("oidc exchange error: %v", err)
		http.Error(w, "authentication failed", http.StatusUnauthorized)
		return
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "no id_token in response", http.StatusUnauthorized)
		return
	}

	idToken, err := a.oidc.verifier.Verify(r.Context(), rawIDToken)
	if err != nil {
		http.Error(w, "invalid id_token", http.StatusUnauthorized)
		return
	}

	var claims struct {
		Email string `json:"email"`
		Sub   string `json:"sub"`
	}
	if err := idToken.Claims(&claims); err != nil {
		http.Error(w, "failed to parse claims", http.StatusInternalServerError)
		return
	}

	userID := claims.Email
	if userID == "" {
		userID = claims.Sub
	}

	data := sessionData{
		UserID: userID,
		Email:  claims.Email,
		Expiry: time.Now().Add(24 * time.Hour).Unix(),
	}

	encoded, err := a.cookie.Encode("orc_session", data)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "orc_session",
		Value:    encoded,
		Path:     "/",
		MaxAge:   86400,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   true,
		Domain:   a.domain,
	})

	// Clear state cookie
	http.SetCookie(w, &http.Cookie{
		Name:   "orc_state",
		Path:   "/auth",
		MaxAge: -1,
	})

	http.Redirect(w, r, "/", http.StatusFound)
}

func UserFromContext(ctx context.Context) string {
	v, _ := ctx.Value(userContextKey).(string)
	return v
}

func (a *Auth) RegistrationAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		if token == "" {
			http.Error(w, "missing authorization", http.StatusUnauthorized)
			return
		}

		// Validate as OIDC Bearer token
		if len(token) < 8 || token[:7] != "Bearer " {
			http.Error(w, "invalid authorization format", http.StatusUnauthorized)
			return
		}
		rawToken := token[7:]

		idToken, err := a.oidc.verifier.Verify(r.Context(), rawToken)
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}

		var claims struct {
			Email string `json:"email"`
			Sub   string `json:"sub"`
		}
		if err := idToken.Claims(&claims); err != nil {
			http.Error(w, "failed to parse claims", http.StatusInternalServerError)
			return
		}

		userID := claims.Email
		if userID == "" {
			userID = claims.Sub
		}

		ctx := context.WithValue(r.Context(), userContextKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// marshalJSON is a helper for JSON responses.
func marshalJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
```

- [ ] **Step 4: Write auth_test.go (middleware unit tests)**

```go
// gateway/auth_test.go
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/securecookie"
)

func testAuth() (*Auth, *securecookie.SecureCookie) {
	secret := make([]byte, 32)
	for i := range secret {
		secret[i] = byte(i)
	}
	sc := securecookie.New(secret, nil)
	sc.MaxAge(86400)
	return &Auth{cookie: sc}, sc
}

func TestMiddlewareRedirectsWithoutCookie(t *testing.T) {
	a, _ := testAuth()
	handler := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/dashboard", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Errorf("expected 302, got %d", rec.Code)
	}
}

func TestMiddlewarePassesWithValidCookie(t *testing.T) {
	a, sc := testAuth()

	data := sessionData{
		UserID: "testuser@example.com",
		Email:  "testuser@example.com",
		Expiry: time.Now().Add(1 * time.Hour).Unix(),
	}
	encoded, _ := sc.Encode("orc_session", data)

	handler := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := UserFromContext(r.Context())
		if user != "testuser@example.com" {
			t.Errorf("expected testuser@example.com, got %s", user)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/dashboard", nil)
	req.AddCookie(&http.Cookie{Name: "orc_session", Value: encoded})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestMiddlewareRedirectsWithExpiredCookie(t *testing.T) {
	a, sc := testAuth()

	data := sessionData{
		UserID: "testuser@example.com",
		Email:  "testuser@example.com",
		Expiry: time.Now().Add(-1 * time.Hour).Unix(),
	}
	encoded, _ := sc.Encode("orc_session", data)

	handler := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/dashboard", nil)
	req.AddCookie(&http.Cookie{Name: "orc_session", Value: encoded})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Errorf("expected 302, got %d", rec.Code)
	}
}
```

- [ ] **Step 5: Run tests**

```bash
cd gateway && go test -run TestMiddleware -v
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/oidc.go gateway/auth.go gateway/auth_test.go
git commit -m "feat: OIDC auth with cookie-based session middleware"
```

---

## Task 4: Go Gateway — Reverse Proxy (HTTP + SSE + WebSocket)

**Files:**
- Create: `gateway/proxy.go`
- Create: `gateway/proxy_test.go`

**Interfaces:**
- Consumes: `Registry.Lookup(sessionID string) (*Session, bool)` from Task 2
- Produces: `ProxyHandler(registry *Registry) http.Handler` — extracts session ID from URL path, looks up endpoint, proxies the request
- URL pattern: `/s/{sessionID}/api/*` → proxied to `{endpoint}/api/*`

The proxy must handle three transport types:
1. **Regular HTTP** — standard reverse proxy
2. **SSE** — long-lived streaming responses (`GET /api/event`, `GET /api/session/{id}/event`); must flush each chunk immediately
3. **WebSocket** — PTY connections (`GET /api/pty/{id}/connect`); full duplex hijack

- [ ] **Step 1: Write proxy_test.go with a mock backend**

```go
// gateway/proxy_test.go
package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProxyRegularHTTP(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/session" {
			t.Errorf("expected /api/session, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"sessions":[]}`))
	}))
	defer backend.Close()

	reg := NewRegistry(30 * time.Second)
	reg.Register("user1", "sess1", backend.URL, "/proj")

	handler := ProxyHandler(reg)
	req := httptest.NewRequest("GET", "/s/sess1/api/session", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "sessions") {
		t.Errorf("unexpected body: %s", rec.Body.String())
	}
}

func TestProxySSEStreaming(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("expected flusher")
		}
		for i := 0; i < 3; i++ {
			w.Write([]byte("event: message\ndata: {\"i\":" + strings.Repeat("0", i) + "}\n\n"))
			flusher.Flush()
		}
	}))
	defer backend.Close()

	reg := NewRegistry(30 * time.Second)
	reg.Register("user1", "sess1", backend.URL, "/proj")

	handler := ProxyHandler(reg)
	req := httptest.NewRequest("GET", "/s/sess1/api/event", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Header().Get("Content-Type") != "text/event-stream" {
		t.Errorf("expected text/event-stream, got %s", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "event: message") {
		t.Errorf("expected SSE events, got: %s", rec.Body.String())
	}
}

func TestProxySessionNotFound(t *testing.T) {
	reg := NewRegistry(30 * time.Second)
	handler := ProxyHandler(reg)

	req := httptest.NewRequest("GET", "/s/nonexistent/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
}

func TestProxyAddsDirectoryHeader(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dir := r.Header.Get("X-Opencode-Directory")
		if dir != "/home/user1/project" {
			t.Errorf("expected X-Opencode-Directory=/home/user1/project, got %s", dir)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	reg := NewRegistry(30 * time.Second)
	reg.Register("user1", "sess1", backend.URL, "/home/user1/project")

	handler := ProxyHandler(reg)
	req := httptest.NewRequest("GET", "/s/sess1/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd gateway && go test -run TestProxy -v
```

Expected: compilation error — `ProxyHandler` not defined.

- [ ] **Step 3: Implement proxy.go**

```go
// gateway/proxy.go
package main

import (
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

func ProxyHandler(registry *Registry) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// URL: /s/{sessionID}/api/...
		// Strip "/s/{sessionID}" prefix, pass the rest to the backend.
		path := r.URL.Path
		if !strings.HasPrefix(path, "/s/") {
			http.NotFound(w, r)
			return
		}
		rest := path[len("/s/"):]
		slashIdx := strings.Index(rest, "/")
		if slashIdx < 0 {
			http.NotFound(w, r)
			return
		}
		sessionID := rest[:slashIdx]
		downstream := rest[slashIdx:] // e.g. "/api/session"

		session, ok := registry.Lookup(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		target, err := url.Parse(session.Endpoint)
		if err != nil {
			http.Error(w, "bad endpoint", http.StatusBadGateway)
			return
		}

		// WebSocket upgrade
		if isWebSocketUpgrade(r) {
			proxyWebSocket(w, r, target, downstream, session)
			return
		}

		proxy := &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL.Scheme = target.Scheme
				req.URL.Host = target.Host
				req.URL.Path = downstream
				req.URL.RawQuery = r.URL.RawQuery
				req.Host = target.Host
				req.Header.Set("X-Opencode-Directory", session.Directory)
			},
			FlushInterval: -1, // flush immediately for SSE
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				log.Printf("proxy error session=%s: %v", sessionID, err)
				http.Error(w, "bad gateway", http.StatusBadGateway)
			},
		}

		proxy.ServeHTTP(w, r)
	})
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func proxyWebSocket(w http.ResponseWriter, r *http.Request, target *url.URL, path string, session *Session) {
	backendURL := *target
	backendURL.Path = path
	backendURL.RawQuery = r.URL.RawQuery

	// Dial backend
	backendConn, err := net.Dial("tcp", target.Host)
	if err != nil {
		http.Error(w, "backend unavailable", http.StatusBadGateway)
		return
	}
	defer backendConn.Close()

	// Hijack client connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, "hijack failed", http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	// Forward the original HTTP request to the backend to initiate the upgrade
	r.URL = &backendURL
	r.Host = target.Host
	r.Header.Set("X-Opencode-Directory", session.Directory)
	if err := r.Write(backendConn); err != nil {
		return
	}

	// Bidirectional copy
	done := make(chan struct{}, 2)
	go func() {
		io.Copy(backendConn, clientConn)
		done <- struct{}{}
	}()
	go func() {
		io.Copy(clientConn, backendConn)
		done <- struct{}{}
	}()
	<-done
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd gateway && go test -run TestProxy -v
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/proxy.go gateway/proxy_test.go
git commit -m "feat: reverse proxy with HTTP, SSE flush, and WebSocket support"
```

---

## Task 5: Go Gateway — Dashboard API and Web UI Serving

**Files:**
- Create: `gateway/dashboard.go`
- Create: `gateway/dashboard_test.go`
- Create: `gateway/webui.go`
- Create: `gateway/routes.go`
- Modify: `gateway/main.go`

**Interfaces:**
- Consumes: `Registry.Sessions(userID string) []Session` from Task 2
- Consumes: `Auth.Middleware` from Task 3
- Consumes: `ProxyHandler` from Task 4
- Produces: `GET /gateway/sessions` — JSON list of user's active sessions
- Produces: `GET /` → serves dashboard HTML (session picker)
- Produces: `GET /s/{sessionID}/*` → serves OpenCode web app static files (SPA catch-all) or proxies `/s/{sessionID}/api/*`

- [ ] **Step 1: Write dashboard_test.go**

```go
// gateway/dashboard_test.go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDashboardSessionsAPI(t *testing.T) {
	reg := NewRegistry(30 * time.Second)
	reg.Register("user1", "sess1", "http://10.0.0.1:4096", "/proj-a")
	reg.Register("user1", "sess2", "http://10.0.0.1:4097", "/proj-b")
	reg.Register("user2", "sess3", "http://10.0.0.2:4096", "/proj-c")

	handler := DashboardSessionsHandler(reg)

	req := httptest.NewRequest("GET", "/gateway/sessions", nil)
	ctx := setUserContext(req.Context(), "user1")
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var sessions []Session
	if err := json.NewDecoder(rec.Body).Decode(&sessions); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if len(sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(sessions))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd gateway && go test -run TestDashboard -v
```

Expected: compilation error.

- [ ] **Step 3: Implement dashboard.go**

```go
// gateway/dashboard.go
package main

import (
	"context"
	"html/template"
	"net/http"
)

func setUserContext(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userContextKey, userID)
}

func DashboardSessionsHandler(registry *Registry) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := UserFromContext(r.Context())
		if userID == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		sessions := registry.Sessions(userID)
		if sessions == nil {
			sessions = []Session{}
		}
		marshalJSON(w, http.StatusOK, sessions)
	})
}

var dashboardTmpl = template.Must(template.New("dashboard").Parse(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>opencode-rc</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 2rem; }
    h1 { margin-bottom: 1.5rem; font-size: 1.5rem; }
    .sessions { display: grid; gap: 1rem; max-width: 600px; }
    .session { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; }
    .session a { color: #58a6ff; text-decoration: none; font-weight: 600; font-size: 1.1rem; }
    .session a:hover { text-decoration: underline; }
    .session .meta { color: #8b949e; font-size: 0.85rem; margin-top: 0.5rem; }
    .empty { color: #8b949e; }
  </style>
</head>
<body>
  <h1>opencode-rc</h1>
  <div id="sessions" class="sessions"><p class="empty">Loading...</p></div>
  <script>
    fetch('/gateway/sessions')
      .then(r => r.json())
      .then(sessions => {
        const el = document.getElementById('sessions');
        if (!sessions.length) {
          el.innerHTML = '<p class="empty">No active sessions. Run opencode-rc on your dev machine to get started.</p>';
          return;
        }
        el.innerHTML = sessions.map(s =>
          '<div class="session">' +
            '<a href="/s/' + s.id + '/">' + s.directory + '</a>' +
            '<div class="meta">Session ' + s.id.slice(0, 8) + ' &middot; ' + s.endpoint + '</div>' +
          '</div>'
        ).join('');
      });
  </script>
</body>
</html>`))

func DashboardHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		dashboardTmpl.Execute(w, nil)
	})
}
```

- [ ] **Step 4: Implement webui.go**

```go
// gateway/webui.go
package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func WebUIHandler(webUIDir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// URL: /s/{sessionID}/... (the /s/{sessionID} prefix is already stripped by the caller)
		// Serve static files; fall back to index.html for SPA routing.
		path := r.URL.Path
		if path == "" || path == "/" {
			path = "/index.html"
		}

		filePath := filepath.Join(webUIDir, filepath.Clean(path))
		if _, err := os.Stat(filePath); err != nil {
			// SPA fallback
			filePath = filepath.Join(webUIDir, "index.html")
		}

		http.ServeFile(w, r, filePath)
	})
}

func SessionWebUIOrProxy(registry *Registry, webUIDir string) http.Handler {
	proxy := ProxyHandler(registry)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !strings.HasPrefix(path, "/s/") {
			http.NotFound(w, r)
			return
		}

		rest := path[len("/s/"):]
		slashIdx := strings.Index(rest, "/")
		if slashIdx < 0 {
			// Redirect /s/sessionID to /s/sessionID/
			http.Redirect(w, r, path+"/", http.StatusFound)
			return
		}

		sessionID := rest[:slashIdx]
		subpath := rest[slashIdx:]

		// Check session exists
		_, ok := registry.Lookup(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		// Proxy API requests to the dev machine
		if strings.HasPrefix(subpath, "/api/") {
			proxy.ServeHTTP(w, r)
			return
		}

		// Serve web UI static files
		if webUIDir != "" {
			r.URL.Path = subpath
			WebUIHandler(webUIDir).ServeHTTP(w, r)
			return
		}

		http.Error(w, "web UI not configured", http.StatusNotFound)
	})
}
```

- [ ] **Step 5: Implement routes.go and update main.go**

```go
// gateway/routes.go
package main

import "net/http"

func SetupRoutes(mux *http.ServeMux, auth *Auth, registry *Registry, webUIDir string) {
	// Health (unauthenticated)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok\n"))
	})

	// Auth endpoints (unauthenticated)
	mux.HandleFunc("/auth/login", auth.LoginHandler)
	mux.HandleFunc("/auth/callback", auth.CallbackHandler)

	// Registration API (CLI uses Bearer token auth)
	regMux := http.NewServeMux()
	regMux.HandleFunc("POST /gateway/register", registrationHandler(registry))
	regMux.HandleFunc("POST /gateway/heartbeat", heartbeatHandler(registry))
	regMux.HandleFunc("POST /gateway/deregister", deregisterHandler(registry))
	mux.Handle("/gateway/register", auth.RegistrationAuthMiddleware(regMux))
	mux.Handle("/gateway/heartbeat", auth.RegistrationAuthMiddleware(regMux))
	mux.Handle("/gateway/deregister", auth.RegistrationAuthMiddleware(regMux))

	// Dashboard + session API (browser cookie auth)
	dashMux := http.NewServeMux()
	dashMux.Handle("/gateway/sessions", DashboardSessionsHandler(registry))
	dashMux.Handle("/", DashboardHandler())
	mux.Handle("/gateway/sessions", auth.Middleware(dashMux))
	mux.Handle("/", auth.Middleware(dashMux))

	// Session proxy + web UI (browser cookie auth)
	mux.Handle("/s/", auth.Middleware(SessionWebUIOrProxy(registry, webUIDir)))
}
```

```go
// gateway/registration_handlers.go — inline in routes.go or separate file
package main

import (
	"encoding/json"
	"net/http"
)

type registerRequest struct {
	SessionID string `json:"sessionId"`
	Endpoint  string `json:"endpoint"`
	Directory string `json:"directory"`
}

func registrationHandler(registry *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := UserFromContext(r.Context())
		var req registerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if req.SessionID == "" || req.Endpoint == "" {
			http.Error(w, "sessionId and endpoint required", http.StatusBadRequest)
			return
		}
		registry.Register(userID, req.SessionID, req.Endpoint, req.Directory)
		marshalJSON(w, http.StatusOK, map[string]string{"status": "registered"})
	}
}

type heartbeatRequest struct {
	SessionID string `json:"sessionId"`
}

func heartbeatHandler(registry *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req heartbeatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if !registry.Heartbeat(req.SessionID) {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		marshalJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

type deregisterRequest struct {
	SessionID string `json:"sessionId"`
}

func deregisterHandler(registry *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req deregisterRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		registry.Deregister(req.SessionID)
		marshalJSON(w, http.StatusOK, map[string]string{"status": "deregistered"})
	}
}
```

Update `main.go`:

```go
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
	oidcProvider, err := NewOIDCProvider(ctx, cfg)
	if err != nil {
		log.Fatalf("oidc: %v", err)
	}

	auth := NewAuth(oidcProvider, cfg.CookieSecret, cfg.CookieDomain)
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
```

- [ ] **Step 6: Run all gateway tests**

```bash
cd gateway && go test ./... -v > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|ok' /tmp/test-output.log
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add gateway/
git commit -m "feat: dashboard, web UI serving, route wiring, and registration handlers"
```

---

## Task 6: Node CLI — Project Scaffolding and Configuration

**Files:**
- Create: `cli/package.json`
- Create: `cli/tsconfig.json`
- Create: `cli/src/config.ts`
- Create: `cli/src/index.ts` (minimal entry)

**Interfaces:**
- Produces: `Config` type with fields `gatewayUrl: string`, `oidcIssuer: string`, `oidcClientID: string`, `oidcTokenEndpoint: string`
- Produces: `loadConfig(): Config` — reads from env vars

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@opencode-rc/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "opencode-rc": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@opencode-ai/sdk": "latest"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write config.ts**

```typescript
// cli/src/config.ts

export interface Config {
  gatewayUrl: string;
  oidcIssuer: string;
  oidcClientID: string;
  oidcTokenEndpoint: string;
}

export function loadConfig(): Config {
  const gatewayUrl = process.env.OPENCODE_RC_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("OPENCODE_RC_GATEWAY_URL is required");

  const oidcIssuer = process.env.OIDC_ISSUER;
  if (!oidcIssuer) throw new Error("OIDC_ISSUER is required");

  const oidcClientID = process.env.OIDC_CLIENT_ID;
  if (!oidcClientID) throw new Error("OIDC_CLIENT_ID is required");

  const oidcTokenEndpoint =
    process.env.OIDC_TOKEN_ENDPOINT || `${oidcIssuer}/oauth/token`;

  return { gatewayUrl, oidcIssuer, oidcClientID, oidcTokenEndpoint };
}
```

- [ ] **Step 4: Write minimal index.ts**

```typescript
#!/usr/bin/env node
// cli/src/index.ts

import { loadConfig } from "./config.js";

async function main() {
  const config = loadConfig();
  console.log("opencode-rc starting...");
  console.log(`Gateway: ${config.gatewayUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Install dependencies and verify build**

```bash
cd cli && npm install && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add cli/
git commit -m "feat: CLI scaffolding with config and entry point"
```

---

## Task 7: Node CLI — OIDC Device Flow

**Files:**
- Create: `cli/src/oidc.ts`
- Create: `cli/test/oidc.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 6 (fields `oidcIssuer`, `oidcClientID`, `oidcTokenEndpoint`)
- Produces: `deviceFlowAuth(config: Config): Promise<{ idToken: string; expiresAt: number }>` — performs OIDC device authorization grant, prints user code + verification URI, polls for token

- [ ] **Step 1: Write oidc.ts**

```typescript
// cli/src/oidc.ts

import type { Config } from "./config.js";

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

export async function deviceFlowAuth(
  config: Config
): Promise<{ idToken: string; expiresAt: number }> {
  // Step 1: Request device code
  const deviceEndpoint =
    process.env.OIDC_DEVICE_ENDPOINT ||
    `${config.oidcIssuer}/oauth/device/code`;

  const deviceRes = await fetch(deviceEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.oidcClientID,
      scope: "openid email profile",
    }),
  });

  if (!deviceRes.ok) {
    throw new Error(
      `Device auth request failed: ${deviceRes.status} ${await deviceRes.text()}`
    );
  }

  const device: DeviceAuthResponse = await deviceRes.json();

  console.log("\nTo authenticate, open this URL in your browser:");
  console.log(`  ${device.verification_uri_complete || device.verification_uri}`);
  console.log(`\nEnter code: ${device.user_code}\n`);

  // Step 2: Poll for token
  const interval = (device.interval || 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    const tokenRes = await fetch(config.oidcTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.oidcClientID,
        device_code: device.device_code,
      }),
    });

    if (tokenRes.ok) {
      const token: TokenResponse = await tokenRes.json();
      return {
        idToken: token.id_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      };
    }

    const err: TokenErrorResponse = await tokenRes.json();
    if (err.error === "authorization_pending") continue;
    if (err.error === "slow_down") {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    throw new Error(`Token error: ${err.error} — ${err.error_description}`);
  }

  throw new Error("Device flow timed out — user did not authorize in time");
}
```

- [ ] **Step 2: Write test (mock server)**

```typescript
// cli/test/oidc.test.ts
import { describe, it, expect } from "vitest";

describe("oidc", () => {
  it("should export deviceFlowAuth", async () => {
    const { deviceFlowAuth } = await import("../src/oidc.js");
    expect(typeof deviceFlowAuth).toBe("function");
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd cli && npx vitest run > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Tests' /tmp/test-output.log
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add cli/src/oidc.ts cli/test/oidc.test.ts
git commit -m "feat: OIDC device flow authentication for CLI"
```

---

## Task 8: Node CLI — Start opencode serve and Register with Gateway

**Files:**
- Create: `cli/src/server.ts`
- Create: `cli/src/register.ts`
- Modify: `cli/src/index.ts`
- Create: `cli/test/register.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 6
- Consumes: `deviceFlowAuth(config)` from Task 7 — returns `{ idToken: string; expiresAt: number }`
- Consumes: `createOpencodeServer(options)` from `@opencode-ai/sdk` — returns `{ url: string; close(): void }`
- Produces: `startServer(gatewayOrigin: string): Promise<{ url: string; close(): void }>` — starts opencode serve with `--cors` for gateway origin
- Produces: `registerWithGateway(config: Config, idToken: string, sessionID: string, endpoint: string, directory: string): Promise<void>` — POST to gateway + heartbeat loop
- Produces: `startHeartbeat(config: Config, idToken: string, sessionID: string): () => void` — returns stop function

- [ ] **Step 1: Write server.ts**

```typescript
// cli/src/server.ts

import { createOpencodeServer } from "@opencode-ai/sdk";

export async function startServer(
  gatewayOrigin: string
): Promise<{ url: string; close(): void }> {
  const server = await createOpencodeServer({
    hostname: "0.0.0.0",
    port: 4096,
    config: {
      server: {
        cors: [gatewayOrigin],
      },
    },
  });
  console.log(`opencode serve running at ${server.url}`);
  return server;
}
```

- [ ] **Step 2: Write register.ts**

```typescript
// cli/src/register.ts

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Config } from "./config.js";

export function generateSessionID(): string {
  return `${hostname()}-${randomUUID().slice(0, 8)}`;
}

export async function registerWithGateway(
  config: Config,
  idToken: string,
  sessionID: string,
  endpoint: string,
  directory: string
): Promise<void> {
  const res = await fetch(`${config.gatewayUrl}/gateway/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ sessionId: sessionID, endpoint, directory }),
  });

  if (!res.ok) {
    throw new Error(
      `Registration failed: ${res.status} ${await res.text()}`
    );
  }

  console.log(`Registered with gateway as session ${sessionID}`);
}

export function startHeartbeat(
  config: Config,
  idToken: string,
  sessionID: string
): () => void {
  const intervalMs = 15_000;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${config.gatewayUrl}/gateway/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ sessionId: sessionID }),
      });
      if (!res.ok) {
        console.error(`Heartbeat failed: ${res.status}`);
      }
    } catch (err) {
      console.error(`Heartbeat error: ${err}`);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

export async function deregisterFromGateway(
  config: Config,
  idToken: string,
  sessionID: string
): Promise<void> {
  try {
    await fetch(`${config.gatewayUrl}/gateway/deregister`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ sessionId: sessionID }),
    });
  } catch {
    // Best-effort on shutdown
  }
}
```

- [ ] **Step 3: Write the full index.ts**

```typescript
#!/usr/bin/env node
// cli/src/index.ts

import { loadConfig } from "./config.js";
import { deviceFlowAuth } from "./oidc.js";
import { startServer } from "./server.js";
import {
  generateSessionID,
  registerWithGateway,
  startHeartbeat,
  deregisterFromGateway,
} from "./register.js";

async function main() {
  const config = loadConfig();
  const cwd = process.cwd();

  console.log("opencode-rc — authenticating...");
  const { idToken } = await deviceFlowAuth(config);
  console.log("Authenticated successfully.\n");

  const gatewayOrigin = new URL(config.gatewayUrl).origin;
  const server = await startServer(gatewayOrigin);

  const sessionID = generateSessionID();
  await registerWithGateway(config, idToken, sessionID, server.url, cwd);

  const stopHeartbeat = startHeartbeat(config, idToken, sessionID);

  console.log(`\nSession available at: ${config.gatewayUrl}/s/${sessionID}/`);
  console.log("Press Ctrl+C to stop.\n");

  const shutdown = async () => {
    console.log("\nShutting down...");
    stopHeartbeat();
    await deregisterFromGateway(config, idToken, sessionID);
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Write register test**

```typescript
// cli/test/register.test.ts
import { describe, it, expect } from "vitest";
import { generateSessionID } from "../src/register.js";

describe("register", () => {
  it("generates a session ID with hostname prefix", () => {
    const id = generateSessionID();
    expect(id).toMatch(/^.+-[a-f0-9]{8}$/);
  });

  it("generates unique session IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionID()));
    expect(ids.size).toBe(100);
  });
});
```

- [ ] **Step 5: Run tests**

```bash
cd cli && npx vitest run > /tmp/test-output.log 2>&1; grep -E 'PASS|FAIL|Tests' /tmp/test-output.log
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/ cli/test/
git commit -m "feat: CLI server start, gateway registration with heartbeat"
```

---

## Task 9: Integration — End-to-End Wiring and Documentation

**Files:**
- Modify: `DESIGN.md` — update with final architecture decisions
- Create: `gateway/Dockerfile` (optional, for deployment)

**Interfaces:**
- Consumes: everything from Tasks 1–8

- [ ] **Step 1: Update DESIGN.md with implementation details**

Add to `DESIGN.md`:

```markdown
## Implementation

### Gateway (Go)

Environment variables:
| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Listen port (default: 8080) |
| `OIDC_ISSUER` | Yes | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | Yes | OAuth client ID |
| `OIDC_CLIENT_SECRET` | No | OAuth client secret (for confidential clients) |
| `OIDC_REDIRECT_URI` | Yes | OAuth callback URL (e.g. `https://gateway.corp/auth/callback`) |
| `COOKIE_SECRET` | Yes | 32-byte hex string for session cookie encryption |
| `COOKIE_DOMAIN` | No | Cookie domain scope |
| `WEBUI_DIR` | No | Path to OpenCode web app `dist/` directory |

### CLI (Node)

Environment variables:
| Variable | Required | Description |
|----------|----------|-------------|
| `OPENCODE_RC_GATEWAY_URL` | Yes | Gateway URL (e.g. `https://gateway.corp`) |
| `OIDC_ISSUER` | Yes | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | Yes | OAuth client ID (must support device flow) |
| `OIDC_TOKEN_ENDPOINT` | No | Override token endpoint (default: `{issuer}/oauth/token`) |
| `OIDC_DEVICE_ENDPOINT` | No | Override device auth endpoint (default: `{issuer}/oauth/device/code`) |

### URL Routing

| Path Pattern | Handler | Auth |
|---|---|---|
| `/healthz` | Health check | None |
| `/auth/login` | OIDC login redirect | None |
| `/auth/callback` | OIDC callback | None |
| `/gateway/register` | CLI registration | Bearer token |
| `/gateway/heartbeat` | CLI heartbeat | Bearer token |
| `/gateway/deregister` | CLI deregister | Bearer token |
| `/gateway/sessions` | List user's sessions (JSON) | Cookie |
| `/` | Dashboard HTML | Cookie |
| `/s/{sessionID}/api/*` | Reverse proxy to dev machine | Cookie |
| `/s/{sessionID}/*` | OpenCode web UI static files | Cookie |
```

- [ ] **Step 2: Create Dockerfile for the gateway**

```dockerfile
# gateway/Dockerfile
FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /gateway .

FROM gcr.io/distroless/static-debian12
COPY --from=build /gateway /gateway
EXPOSE 8080
ENTRYPOINT ["/gateway"]
```

- [ ] **Step 3: Verify full gateway build**

```bash
cd gateway && go build -o /dev/null .
```

- [ ] **Step 4: Verify full CLI build**

```bash
cd cli && npx tsc --noEmit
```

- [ ] **Step 5: Run all tests**

```bash
cd gateway && go test ./... -v > /tmp/gateway-test.log 2>&1; grep -E 'PASS|FAIL|ok' /tmp/gateway-test.log
cd cli && npx vitest run > /tmp/cli-test.log 2>&1; grep -E 'PASS|FAIL|Tests' /tmp/cli-test.log
```

- [ ] **Step 6: Commit**

```bash
git add DESIGN.md gateway/Dockerfile
git commit -m "docs: update DESIGN.md with implementation details, add gateway Dockerfile"
```

---

## Self-Review Notes

**Spec coverage:**
- Gateway OIDC auth (authorization code flow) → Task 3
- Session registry with heartbeat/TTL → Task 2
- Reverse proxy (HTTP, SSE, WebSocket) → Task 4
- Dashboard listing sessions → Task 5
- Serve OpenCode web UI → Task 5
- CLI OIDC device flow → Task 7
- CLI starts opencode serve → Task 8
- CLI registers with gateway → Task 8
- CLI heartbeat + graceful shutdown → Task 8

**Key design decisions:**
- The proxy injects `X-Opencode-Directory` header so `opencode serve` knows which project directory the request targets
- URL scheme: `/s/{sessionID}/api/*` proxied, `/s/{sessionID}/*` serves web UI — the web app's `location.origin` resolves to the gateway, and `/api/*` is relative, so the proxy path is transparent
- CLI binds `opencode serve` to `0.0.0.0` (not `127.0.0.1`) so the gateway can reach it over the network
- CLI passes `--cors` with the gateway origin so `opencode serve` allows cross-origin requests from the gateway
- `FlushInterval: -1` in the reverse proxy ensures SSE events are flushed immediately

**Type consistency check:** `Session` struct used consistently across registry, dashboard, and proxy. `Config` structs are separate per component (Go vs Node) with matching env var names where applicable (`OIDC_ISSUER`, `OIDC_CLIENT_ID`).
