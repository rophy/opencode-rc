package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// AccessClaims is the payload of an access token issued by the web server.
type AccessClaims struct {
	Typ   string `json:"typ"`
	UID   string `json:"uid"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Exp   int64  `json:"exp"`
}

func verifyAccessToken(token string, secret []byte, now time.Time) (*AccessClaims, bool) {
	lastDot := strings.LastIndex(token, ".")
	if lastDot <= 0 {
		return nil, false
	}
	payload := token[:lastDot]
	gotMac := token[lastDot+1:]

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	expectedMac := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(gotMac), []byte(expectedMac)) {
		return nil, false
	}

	jsonBytes, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, false
	}
	var claims AccessClaims
	if err := json.Unmarshal(jsonBytes, &claims); err != nil {
		return nil, false
	}
	if claims.Typ != "access" || claims.Exp == 0 || now.Unix() >= claims.Exp {
		return nil, false
	}
	return &claims, true
}

// bearerToken reads the access token from the Authorization header, or from
// the access_token query parameter on WebSocket upgrades (browsers cannot set
// headers on WebSocket connections).
func bearerToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(h[len("Bearer "):])
	}
	if isWebSocketUpgrade(r) {
		return r.URL.Query().Get("access_token")
	}
	return ""
}

// stripAccessToken removes access_token from a raw query so it is not
// forwarded to opencode. Queries without it are returned unchanged.
func stripAccessToken(rawQuery string) string {
	q, err := url.ParseQuery(rawQuery)
	if err != nil || !q.Has("access_token") {
		return rawQuery
	}
	q.Del("access_token")
	return q.Encode()
}
