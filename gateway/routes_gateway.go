package main

import (
	"net/http"
)

func SetupGatewayRoutes(mux *http.ServeMux, verifier, cliVerifier TokenVerifier, registry *TunnelRegistry, podAddr string, tokenSecret []byte) {
	mux.HandleFunc("/debug/coverage", CoverageHandler())
	mux.HandleFunc("/tunnel", TunnelHandler(verifier, cliVerifier, registry, podAddr))
	mux.Handle("/proxy/", GatewayProxyHandler(registry, tokenSecret))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		if err := registry.store.Ping(r.Context()); err != nil {
			status = "degraded"
		}
		marshalJSON(w, http.StatusOK, map[string]any{"status": status, "version": version, "protocol": TunnelProtocol})
	})
}
