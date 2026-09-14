// gateway/config_test.go
package main

import (
	"strings"
	"testing"
)

func TestLoadConfigAllFields(t *testing.T) {
	t.Setenv("PORT", "9090")
	t.Setenv("OIDC_ISSUER", "http://issuer")
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("OIDC_CLIENT_SECRET", "secret")
	t.Setenv("OIDC_REDIRECT_URI", "http://redirect")
	t.Setenv("COOKIE_SECRET", strings.Repeat("0123456789abcdef", 4))
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("COOKIE_SECURE", "false")
	t.Setenv("WEBUI_DIR", "/tmp/webui")
	t.Setenv("OIDC_CLI_CLIENT_ID", "cli-client")
	t.Setenv("COOKIE_DOMAIN", "example.com")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Port != 9090 {
		t.Errorf("expected Port 9090, got %d", cfg.Port)
	}
	if cfg.OIDCIssuer != "http://issuer" {
		t.Errorf("expected OIDCIssuer http://issuer, got %s", cfg.OIDCIssuer)
	}
	if cfg.OIDCClientID != "client" {
		t.Errorf("expected OIDCClientID client, got %s", cfg.OIDCClientID)
	}
	if cfg.OIDCClientSecret != "secret" {
		t.Errorf("expected OIDCClientSecret secret, got %s", cfg.OIDCClientSecret)
	}
	if cfg.OIDCRedirectURI != "http://redirect" {
		t.Errorf("expected OIDCRedirectURI http://redirect, got %s", cfg.OIDCRedirectURI)
	}
	if len(cfg.CookieSecret) != 32 {
		t.Errorf("expected CookieSecret length 32, got %d", len(cfg.CookieSecret))
	}
	if cfg.SecureCookies != false {
		t.Errorf("expected SecureCookies false, got %v", cfg.SecureCookies)
	}
	if cfg.WebUIDir != "/tmp/webui" {
		t.Errorf("expected WebUIDir /tmp/webui, got %s", cfg.WebUIDir)
	}
	if cfg.OIDCCLIClientID != "cli-client" {
		t.Errorf("expected OIDCCLIClientID cli-client, got %s", cfg.OIDCCLIClientID)
	}
	if cfg.CookieDomain != "example.com" {
		t.Errorf("expected CookieDomain example.com, got %s", cfg.CookieDomain)
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "http://issuer")
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("OIDC_REDIRECT_URI", "http://redirect")
	t.Setenv("COOKIE_SECRET", strings.Repeat("0123456789abcdef", 4))
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Port != 8080 {
		t.Errorf("expected default Port 8080, got %d", cfg.Port)
	}
	if cfg.SecureCookies != true {
		t.Errorf("expected default SecureCookies true, got %v", cfg.SecureCookies)
	}
	if cfg.WebUIDir != "" {
		t.Errorf("expected default WebUIDir empty, got %s", cfg.WebUIDir)
	}
}

func TestLoadConfigMissingIssuer(t *testing.T) {
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("OIDC_REDIRECT_URI", "http://redirect")
	t.Setenv("COOKIE_SECRET", strings.Repeat("0123456789abcdef", 4))
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")

	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "OIDC_ISSUER is required") {
		t.Fatalf("expected OIDC_ISSUER is required error, got %v", err)
	}
}

func TestLoadConfigMissingClientID(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "http://issuer")
	t.Setenv("OIDC_REDIRECT_URI", "http://redirect")
	t.Setenv("COOKIE_SECRET", strings.Repeat("0123456789abcdef", 4))
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")

	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "OIDC_CLIENT_ID is required") {
		t.Fatalf("expected OIDC_CLIENT_ID is required error, got %v", err)
	}
}

func TestLoadConfigMissingRedirectURI(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "http://issuer")
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("COOKIE_SECRET", strings.Repeat("0123456789abcdef", 4))
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")

	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "OIDC_REDIRECT_URI is required") {
		t.Fatalf("expected OIDC_REDIRECT_URI is required error, got %v", err)
	}
}

func TestLoadConfigMissingCookieSecret(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "http://issuer")
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("OIDC_REDIRECT_URI", "http://redirect")

	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "COOKIE_SECRET is required") {
		t.Fatalf("expected COOKIE_SECRET is required error, got %v", err)
	}
}

func TestLoadConfigInvalidCookieSecret(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "http://issuer")
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("OIDC_REDIRECT_URI", "http://redirect")
	t.Setenv("COOKIE_SECRET", "notvalidhex")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")

	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "COOKIE_SECRET must be") {
		t.Fatalf("expected COOKIE_SECRET must be error, got %v", err)
	}
}

func TestLoadConfigInvalidPort(t *testing.T) {
	t.Setenv("PORT", "notanumber")
	t.Setenv("OIDC_ISSUER", "http://issuer")
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("OIDC_REDIRECT_URI", "http://redirect")
	t.Setenv("COOKIE_SECRET", strings.Repeat("0123456789abcdef", 4))
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")

	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "PORT must be") {
		t.Fatalf("expected PORT must be an integer error, got %v", err)
	}
}

func TestLoadConfigMissingRedisURL(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "http://issuer")
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("OIDC_REDIRECT_URI", "http://redirect")
	t.Setenv("COOKIE_SECRET", strings.Repeat("0123456789abcdef", 4))
	t.Setenv("REDIS_URL", "")

	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "REDIS_URL is required") {
		t.Fatalf("expected REDIS_URL is required error, got %v", err)
	}
}

func TestLoadConfigPodIP(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "http://issuer")
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("OIDC_REDIRECT_URI", "http://redirect")
	t.Setenv("COOKIE_SECRET", strings.Repeat("0123456789abcdef", 4))
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("POD_IP", "10.0.0.1")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PodIP != "10.0.0.1" {
		t.Errorf("PodIP = %q, want %q", cfg.PodIP, "10.0.0.1")
	}
}
