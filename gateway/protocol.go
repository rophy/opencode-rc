package main

import (
	"net/http"
	"regexp"
	"strconv"
)

// Client/server compatibility for the CLI tunnel, independent of release versions
// (docs/api-versioning.md). Bump TunnelProtocol for changes old CLIs cannot handle;
// raise MinCLIProtocol when those CLIs are no longer supported.
const (
	ProtocolHeader = "OpenCode-RC-Protocol"
	TunnelProtocol = 1
	MinCLIProtocol = 1
)

const cliTooOldMessage = "opencode-rc CLI is too old for this server. Update it: npm i -g opencode-rc@latest"

var protocolPattern = regexp.MustCompile(`^\d+$`)

func readProtocol(v string) int {
	if !protocolPattern.MatchString(v) {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0
	}
	return n
}

func withProtocolHeader(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(ProtocolHeader, strconv.Itoa(TunnelProtocol))
		h.ServeHTTP(w, r)
	})
}

// checkCLIProtocol rejects CLIs older than MinCLIProtocol. CLIs released before protocol
// versioning send no header and print the pre-flight body only for 401/403/5xx, so they
// get a plain-text 403.
func checkCLIProtocol(w http.ResponseWriter, r *http.Request) bool {
	raw := r.Header.Get(ProtocolHeader)
	client := readProtocol(raw)
	if client >= MinCLIProtocol {
		return true
	}
	if raw == "" {
		http.Error(w, cliTooOldMessage, http.StatusForbidden)
		return false
	}
	marshalJSON(w, http.StatusUpgradeRequired, map[string]any{
		"error": "client_outdated", "client": client, "minimum": MinCLIProtocol, "server": TunnelProtocol,
	})
	return false
}
