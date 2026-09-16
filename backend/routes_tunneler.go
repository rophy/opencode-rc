package main

import (
	"net/http"
)

func SetupTunnelerRoutes(mux *http.ServeMux, verifier, cliVerifier TokenVerifier, registry *TunnelRegistry, podAddr string) {
	mux.HandleFunc("/debug/coverage", CoverageHandler())
	mux.HandleFunc("/tunnel", TunnelHandler(verifier, cliVerifier, registry, podAddr))
	mux.Handle("/proxy/", TunnelerProxyHandler(registry))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		if err := registry.store.Ping(r.Context()); err != nil {
			status = "degraded"
		}
		marshalJSON(w, http.StatusOK, map[string]string{"status": status, "version": version})
	})
}
