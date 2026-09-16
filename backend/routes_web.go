package main

import "net/http"

func SetupWebRoutes(mux *http.ServeMux, auth *Auth, store SessionStore, webUIDir string) {
	mux.HandleFunc("/debug/coverage", CoverageHandler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		if err := store.Ping(r.Context()); err != nil {
			status = "degraded"
		}
		marshalJSON(w, http.StatusOK, map[string]string{"status": status, "version": version})
	})

	mux.HandleFunc("/auth/login", auth.LoginPageHandler)
	mux.HandleFunc("/auth/start", auth.LoginStartHandler)
	mux.HandleFunc("/auth/callback", auth.CallbackHandler)
	mux.HandleFunc("/auth/logout", auth.LogoutHandler)

	mux.Handle("/api/me", auth.Middleware(MeHandler()))

	dashMux := http.NewServeMux()
	dashMux.Handle("/gateway/sessions", DashboardSessionsHandler(store))
	if webUIDir != "" {
		dashMux.Handle("/", WebUIHandler(webUIDir))
	} else {
		dashMux.Handle("/", DashboardHandler())
	}
	mux.Handle("/gateway/sessions", auth.Middleware(dashMux))
	mux.Handle("/", auth.Middleware(dashMux))

	mux.Handle("/s/", auth.Middleware(SessionWebUIOrProxy(store, webUIDir)))
}
