package main

import (
	"net/http"
)

func SetupGatewayRoutes(mux *http.ServeMux, verifier, cliVerifier TokenVerifier, registry *TunnelRegistry, podAddr string, cookieSecret []byte) {
	mux.HandleFunc("/debug/coverage", CoverageHandler())
	mux.HandleFunc("/tunnel", TunnelHandler(verifier, cliVerifier, registry, podAddr))
	mux.Handle("/proxy/", GatewayProxyHandler(registry, cookieSecret))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		if err := registry.store.Ping(r.Context()); err != nil {
			status = "degraded"
		}
		marshalJSON(w, http.StatusOK, map[string]string{"status": status, "version": version})
	})
}
