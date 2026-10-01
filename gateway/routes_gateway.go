package main

import (
	"net/http"
)

func SetupGatewayRoutes(mux *http.ServeMux, verifier, cliVerifier TokenVerifier, registry *TunnelRegistry, podAddr, userClaim string, tokenSecret []byte) {
	mux.HandleFunc("/debug/coverage", CoverageHandler())
	mux.HandleFunc("/tunnel", TunnelHandler(verifier, cliVerifier, registry, podAddr, userClaim))
	mux.Handle("/proxy/", GatewayProxyHandler(registry, tokenSecret))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		if err := registry.store.Ping(r.Context()); err != nil {
			status = "degraded"
		}
		marshalJSON(w, http.StatusOK, map[string]any{"status": status, "version": version, "protocol": TunnelProtocol})
	})
}

// CLIConfigHandler lets the CLI log in with only the gateway URL configured. The
// authorization endpoint override is browser-facing, so the CLI can use it too; the
// token endpoint override may be in-cluster and is not published.
func CLIConfigHandler(issuer, cliClientID, authorizationEndpoint string) http.HandlerFunc {
	body := map[string]string{"issuer": issuer}
	if cliClientID != "" {
		body["clientId"] = cliClientID
	}
	if authorizationEndpoint != "" {
		body["authorizationEndpoint"] = authorizationEndpoint
	}
	return func(w http.ResponseWriter, r *http.Request) {
		marshalJSON(w, http.StatusOK, body)
	}
}
