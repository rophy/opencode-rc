package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func mockOIDCServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		// Dynamically build the discovery doc using the server's own URL.
		// We use a placeholder that gets replaced — but since we can't know
		// the URL before the server starts, we use a trick: serve a handler
		// that uses r.Host.
		scheme := "http"
		issuer := scheme + "://" + r.Host
		doc := map[string]interface{}{
			"issuer":                                issuer,
			"authorization_endpoint":                issuer + "/authorize",
			"token_endpoint":                        issuer + "/token",
			"jwks_uri":                              issuer + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(doc)
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"keys":[]}`))
	})
	return httptest.NewServer(mux)
}

func TestNewOIDCProvider(t *testing.T) {
	srv := mockOIDCServer(t)
	defer srv.Close()

	cfg := &Config{
		OIDCIssuer:       srv.URL,
		OIDCClientID:     "test-client",
		OIDCClientSecret: "test-secret",
		OIDCRedirectURI:  "http://localhost/callback",
	}

	provider, err := NewOIDCProvider(context.Background(), cfg)
	if err != nil {
		t.Fatalf("NewOIDCProvider failed: %v", err)
	}
	if provider == nil {
		t.Fatal("expected non-nil provider")
	}
	if provider.verifier == nil {
		t.Error("expected non-nil verifier")
	}
	if provider.cliVerifier != nil {
		t.Error("expected nil cliVerifier when OIDCCLIClientID is empty")
	}
}

func TestNewOIDCProviderWithCLIClient(t *testing.T) {
	srv := mockOIDCServer(t)
	defer srv.Close()

	cfg := &Config{
		OIDCIssuer:       srv.URL,
		OIDCClientID:     "test-client",
		OIDCClientSecret: "test-secret",
		OIDCRedirectURI:  "http://localhost/callback",
		OIDCCLIClientID:  "cli-client",
	}

	provider, err := NewOIDCProvider(context.Background(), cfg)
	if err != nil {
		t.Fatalf("NewOIDCProvider failed: %v", err)
	}
	if provider.cliVerifier == nil {
		t.Error("expected non-nil cliVerifier when OIDCCLIClientID is set")
	}
}

func TestNewOIDCProviderInvalidIssuer(t *testing.T) {
	cfg := &Config{
		OIDCIssuer:   "http://127.0.0.1:1/nonexistent",
		OIDCClientID: "test-client",
	}

	_, err := NewOIDCProvider(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected error for unreachable issuer")
	}
}

func TestIDTokenVerifierVerify(t *testing.T) {
	srv := mockOIDCServer(t)
	defer srv.Close()

	cfg := &Config{
		OIDCIssuer:       srv.URL,
		OIDCClientID:     "test-client",
		OIDCClientSecret: "test-secret",
		OIDCRedirectURI:  "http://localhost/callback",
	}

	provider, err := NewOIDCProvider(context.Background(), cfg)
	if err != nil {
		t.Fatalf("NewOIDCProvider failed: %v", err)
	}

	_, err = provider.verifier.Verify(context.Background(), "invalid-token")
	if err == nil {
		t.Error("expected error verifying invalid token")
	}
}
