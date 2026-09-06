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
