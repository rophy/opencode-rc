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
	oidc         *OIDCProvider
	cookie       *securecookie.SecureCookie
	domain       string
	secureCookie bool
}

func NewAuth(oidc *OIDCProvider, cookieSecret []byte, domain string, secureCookie bool) *Auth {
	sc := securecookie.New(cookieSecret, nil)
	sc.MaxAge(86400)
	return &Auth{oidc: oidc, cookie: sc, domain: domain, secureCookie: secureCookie}
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
		Secure:   a.secureCookie,
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
		Secure:   a.secureCookie,
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
