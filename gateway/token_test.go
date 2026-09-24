package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

var testTokenSecret = []byte("0123456789abcdef0123456789abcdef")

func signTestToken(t *testing.T, claims map[string]any) string {
	t.Helper()
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	payload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, testTokenSecret)
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func testAccessToken(t *testing.T, uid string) string {
	return signTestToken(t, map[string]any{
		"typ": "access", "uid": uid, "email": uid, "name": "Test",
		"exp": time.Now().Add(15 * time.Minute).Unix(),
	})
}

func TestVerifyAccessTokenValid(t *testing.T) {
	claims, ok := verifyAccessToken(testAccessToken(t, "user1"), testTokenSecret, time.Now())
	if !ok || claims.UID != "user1" {
		t.Fatalf("expected valid token for user1, got %v %v", claims, ok)
	}
}

func TestVerifyAccessTokenRejects(t *testing.T) {
	now := time.Now()
	cases := map[string]string{
		"expired": signTestToken(t, map[string]any{"typ": "access", "uid": "u", "exp": now.Add(-time.Second).Unix()}),
		"no typ":  signTestToken(t, map[string]any{"uid": "u", "exp": now.Add(time.Hour).Unix()}),
		"no exp":  signTestToken(t, map[string]any{"typ": "access", "uid": "u"}),
		"garbage": "abc",
		"empty":   "",
	}
	for name, tok := range cases {
		if _, ok := verifyAccessToken(tok, testTokenSecret, now); ok {
			t.Errorf("%s: expected rejection", name)
		}
	}
	if _, ok := verifyAccessToken(testAccessToken(t, "u"), []byte("another-secret-another-secret-xx"), now); ok {
		t.Error("wrong secret: expected rejection")
	}
}

func TestBearerToken(t *testing.T) {
	r := httptest.NewRequest("GET", "/proxy/s/x", nil)
	r.Header.Set("Authorization", "Bearer abc")
	if got := bearerToken(r); got != "abc" {
		t.Errorf("header: got %q", got)
	}

	r = httptest.NewRequest("GET", "/proxy/s/x?access_token=q", nil)
	if got := bearerToken(r); got != "" {
		t.Errorf("query on plain request should be ignored, got %q", got)
	}

	r = httptest.NewRequest("GET", "/proxy/s/x?access_token=q", nil)
	r.Header.Set("Upgrade", "websocket")
	if got := bearerToken(r); got != "q" {
		t.Errorf("query on upgrade: got %q", got)
	}
}

func TestStripAccessToken(t *testing.T) {
	if got := stripAccessToken("a=1&access_token=x&b=2"); got != "a=1&b=2" {
		t.Errorf("got %q", got)
	}
	if got := stripAccessToken("location%5Bdirectory%5D=%2Fp&cursor=0"); got != "location%5Bdirectory%5D=%2Fp&cursor=0" {
		t.Errorf("queries without access_token must be untouched, got %q", got)
	}
}
