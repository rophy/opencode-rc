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

func (p *OIDCProvider) Verifier() *oidc.IDTokenVerifier {
	return p.verifier
}
