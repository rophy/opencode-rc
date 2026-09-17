package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

type CookieSession struct {
	UID   string `json:"uid"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Exp   int64  `json:"exp"`
}

func verifyCookie(value string, secret []byte) (*CookieSession, bool) {
	lastDot := strings.LastIndex(value, ".")
	if lastDot < 0 {
		return nil, false
	}
	payload := value[:lastDot]
	gotMac := value[lastDot+1:]

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

	var session CookieSession
	if err := json.Unmarshal(jsonBytes, &session); err != nil {
		return nil, false
	}

	if session.Exp > 0 && time.Now().Unix() > session.Exp {
		return nil, false
	}

	return &session, true
}
