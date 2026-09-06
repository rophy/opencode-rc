// gateway/config.go
package main

import (
	"encoding/hex"
	"errors"
	"os"
	"strconv"
)

type Config struct {
	Port             int
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string
	OIDCRedirectURI  string
	WebUIDir         string
	CookieSecret     []byte
	CookieDomain     string
	SecureCookies    bool
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

	secureCookies := true
	if v := os.Getenv("COOKIE_SECURE"); v == "false" {
		secureCookies = false
	}

	return &Config{
		Port:             port,
		OIDCIssuer:       issuer,
		OIDCClientID:     clientID,
		OIDCClientSecret: clientSecret,
		OIDCRedirectURI:  redirectURI,
		WebUIDir:         webUIDir,
		CookieSecret:     secret,
		CookieDomain:     os.Getenv("COOKIE_DOMAIN"),
		SecureCookies:    secureCookies,
	}, nil
}
