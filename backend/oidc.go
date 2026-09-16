package main

import (
	"context"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// ClaimsToken is satisfied by *oidc.IDToken. It lets tests substitute a
// verified token without depending on go-oidc's unexported internals.
type ClaimsToken interface {
	Claims(v interface{}) error
}

// TokenVerifier abstracts *oidc.IDTokenVerifier so tests can inject a mock
// verifier for OIDC-dependent handlers.
type TokenVerifier interface {
	Verify(ctx context.Context, rawIDToken string) (ClaimsToken, error)
}

// idTokenVerifier adapts *oidc.IDTokenVerifier to TokenVerifier.
type idTokenVerifier struct {
	v *oidc.IDTokenVerifier
}

func (w idTokenVerifier) Verify(ctx context.Context, rawIDToken string) (ClaimsToken, error) {
	return w.v.Verify(ctx, rawIDToken)
}

type OIDCProvider struct {
	provider     *oidc.Provider
	oauth2Config oauth2.Config
	verifier     TokenVerifier
	cliVerifier  TokenVerifier
}

func NewOIDCProvider(ctx context.Context, cfg *Config) (*OIDCProvider, error) {
	provider, err := oidc.NewProvider(ctx, cfg.OIDCIssuer)
	if err != nil {
		return nil, err
	}

	return newOIDCProviderFromProvider(provider, cfg), nil
}

func newOIDCProviderFromProvider(provider *oidc.Provider, cfg *Config) *OIDCProvider {
	oauth2Config := oauth2.Config{
		ClientID:     cfg.OIDCClientID,
		ClientSecret: cfg.OIDCClientSecret,
		RedirectURL:  cfg.OIDCRedirectURI,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
	}

	verifier := idTokenVerifier{provider.Verifier(&oidc.Config{ClientID: cfg.OIDCClientID})}

	var cliVerifier TokenVerifier
	if cfg.OIDCCLIClientID != "" {
		cliVerifier = idTokenVerifier{provider.Verifier(&oidc.Config{ClientID: cfg.OIDCCLIClientID})}
	}

	return &OIDCProvider{
		provider:     provider,
		oauth2Config: oauth2Config,
		verifier:     verifier,
		cliVerifier:  cliVerifier,
	}
}
