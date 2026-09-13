// gateway/auth_test.go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/securecookie"
	"golang.org/x/oauth2"
)

// mockToken is a ClaimsToken backed by literal JSON claims.
type mockToken struct {
	claims string
}

func (m *mockToken) Claims(v interface{}) error {
	return json.Unmarshal([]byte(m.claims), v)
}

// mockVerifier is a TokenVerifier that returns fixed claims or an error,
// regardless of the raw token passed in.
type mockVerifier struct {
	claims string
	err    error
}

func (m *mockVerifier) Verify(ctx context.Context, rawIDToken string) (ClaimsToken, error) {
	if m.err != nil {
		return nil, m.err
	}
	return &mockToken{claims: m.claims}, nil
}

// testAuthWithVerifier builds an Auth with a mock primary verifier and an
// optional mock CLI-fallback verifier for testing OIDC-dependent handlers.
func testAuthWithVerifier(verifier, cliVerifier TokenVerifier) *Auth {
	secret := make([]byte, 32)
	sc := securecookie.New(secret, nil)
	sc.MaxAge(86400)
	return &Auth{
		oidc: &OIDCProvider{
			verifier:    verifier,
			cliVerifier: cliVerifier,
			oauth2Config: oauth2.Config{
				ClientID: "test-client",
				Endpoint: oauth2.Endpoint{
					AuthURL: "http://mock-oidc/authorize",
				},
				Scopes: []string{"openid"},
			},
		},
		cookie: sc,
	}
}

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

func TestLoginPageHandler(t *testing.T) {
	a, _ := testAuth()

	req := httptest.NewRequest("GET", "/auth/login", nil)
	rec := httptest.NewRecorder()
	a.LoginPageHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "text/html") {
		t.Errorf("expected text/html content type, got %s", rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Body.String(), "Sign in with OIDC") {
		t.Errorf("expected body to contain 'Sign in with OIDC', got: %s", rec.Body.String())
	}
}

func TestLogoutHandler(t *testing.T) {
	a, _ := testAuth()

	req := httptest.NewRequest("GET", "/auth/logout", nil)
	rec := httptest.NewRecorder()
	a.LogoutHandler(rec, req)

	if rec.Code != http.StatusFound {
		t.Errorf("expected 302, got %d", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/" {
		t.Errorf("expected redirect to /, got %s", loc)
	}

	var found *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "orc_session" {
			found = c
			break
		}
	}
	if found == nil {
		t.Fatal("expected orc_session cookie to be set")
	}
	if found.MaxAge != -1 {
		t.Errorf("expected MaxAge -1, got %d", found.MaxAge)
	}
}

func TestMeHandlerUnauthorized(t *testing.T) {
	req := httptest.NewRequest("GET", "/me", nil)
	rec := httptest.NewRecorder()
	MeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestMeHandlerWithSession(t *testing.T) {
	data := sessionData{UserID: "user1", Email: "user1@example.com", Name: "User One"}

	req := httptest.NewRequest("GET", "/me", nil)
	ctx := context.WithValue(req.Context(), sessionContextKey, data)
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	MeHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if body["sub"] != "user1" {
		t.Errorf("expected sub user1, got %s", body["sub"])
	}
	if body["email"] != "user1@example.com" {
		t.Errorf("expected email user1@example.com, got %s", body["email"])
	}
	if body["name"] != "User One" {
		t.Errorf("expected name User One, got %s", body["name"])
	}
}

func TestSessionFromContext(t *testing.T) {
	data := sessionData{UserID: "user1", Email: "user1@example.com"}
	ctx := context.WithValue(context.Background(), sessionContextKey, data)

	got, ok := SessionFromContext(ctx)
	if !ok {
		t.Fatal("expected ok true")
	}
	if got.UserID != "user1" {
		t.Errorf("expected UserID user1, got %s", got.UserID)
	}

	_, ok = SessionFromContext(context.Background())
	if ok {
		t.Error("expected ok false for context without session")
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

func TestLoginStartHandler(t *testing.T) {
	a := testAuthWithVerifier(&mockVerifier{}, nil)

	req := httptest.NewRequest("GET", "/auth/start", nil)
	rec := httptest.NewRecorder()
	a.LoginStartHandler(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("expected 302, got %d", rec.Code)
	}

	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "http://mock-oidc/authorize") {
		t.Errorf("expected redirect to mock-oidc authorize endpoint, got %s", loc)
	}

	var found *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "orc_state" {
			found = c
			break
		}
	}
	if found == nil {
		t.Fatal("expected orc_state cookie to be set")
	}
	if found.Value == "" {
		t.Error("expected orc_state cookie to have a value")
	}
	if !strings.Contains(loc, "state="+found.Value) {
		t.Errorf("expected redirect URL to contain state=%s, got %s", found.Value, loc)
	}
}

func TestRegistrationAuthMiddlewareMissingHeader(t *testing.T) {
	a := testAuthWithVerifier(&mockVerifier{}, nil)
	handler := a.RegistrationAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("next handler should not be called")
	}))

	req := httptest.NewRequest("GET", "/register", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestRegistrationAuthMiddlewareInvalidFormat(t *testing.T) {
	a := testAuthWithVerifier(&mockVerifier{}, nil)
	handler := a.RegistrationAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("next handler should not be called")
	}))

	req := httptest.NewRequest("GET", "/register", nil)
	req.Header.Set("Authorization", "Basic xxx")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestRegistrationAuthMiddlewareInvalidToken(t *testing.T) {
	a := testAuthWithVerifier(&mockVerifier{err: errors.New("bad signature")}, nil)
	handler := a.RegistrationAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("next handler should not be called")
	}))

	req := httptest.NewRequest("GET", "/register", nil)
	req.Header.Set("Authorization", "Bearer bad-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestRegistrationAuthMiddlewareValidToken(t *testing.T) {
	a := testAuthWithVerifier(&mockVerifier{claims: `{"email":"user1@example.com","sub":"sub1"}`}, nil)

	var gotUser string
	handler := a.RegistrationAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/register", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if gotUser != "user1@example.com" {
		t.Errorf("expected user1@example.com, got %s", gotUser)
	}
}

func TestRegistrationAuthMiddlewareCLIFallback(t *testing.T) {
	primary := &mockVerifier{err: errors.New("wrong audience")}
	cli := &mockVerifier{claims: `{"email":"cliuser@example.com","sub":"sub2"}`}
	a := testAuthWithVerifier(primary, cli)

	var gotUser string
	handler := a.RegistrationAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser = UserFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/register", nil)
	req.Header.Set("Authorization", "Bearer cli-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if gotUser != "cliuser@example.com" {
		t.Errorf("expected cliuser@example.com, got %s", gotUser)
	}
}

func TestCallbackHandlerInvalidState(t *testing.T) {
	a := testAuthWithVerifier(&mockVerifier{}, nil)

	req := httptest.NewRequest("GET", "/auth/callback?state=abc&code=xyz", nil)
	req.AddCookie(&http.Cookie{Name: "orc_state", Value: "different"})
	rec := httptest.NewRecorder()
	a.CallbackHandler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestCallbackHandlerMissingStateCookie(t *testing.T) {
	a := testAuthWithVerifier(&mockVerifier{}, nil)

	req := httptest.NewRequest("GET", "/auth/callback?state=abc&code=xyz", nil)
	rec := httptest.NewRecorder()
	a.CallbackHandler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRegistrationAuthMiddlewareBothFail(t *testing.T) {
	primary := &mockVerifier{err: errors.New("expired")}
	cli := &mockVerifier{err: errors.New("wrong audience")}
	a := testAuthWithVerifier(primary, cli)

	handler := a.RegistrationAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("next handler should not be called")
	}))

	req := httptest.NewRequest("GET", "/register", nil)
	req.Header.Set("Authorization", "Bearer bad-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}
