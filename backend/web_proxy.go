package main

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

func WebProxyHandler(store SessionStore) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !strings.HasPrefix(path, "/s/") {
			http.NotFound(w, r)
			return
		}
		rest := path[len("/s/"):]
		slashIdx := strings.Index(rest, "/")
		if slashIdx < 0 {
			http.NotFound(w, r)
			return
		}
		sessionID := rest[:slashIdx]
		downstream := rest[slashIdx:]

		meta, ok, err := store.Get(r.Context(), sessionID)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		uid, _ := r.Context().Value(userContextKey).(string)
		if !ok || (uid != "" && uid != meta.UserID) {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		if meta.TunnelerAddr == "" {
			http.Error(w, "session has no tunneler", http.StatusBadGateway)
			return
		}

		target, err := url.Parse(fmt.Sprintf("http://%s", meta.TunnelerAddr))
		if err != nil {
			http.Error(w, "bad tunneler address", http.StatusBadGateway)
			return
		}

		proxy := &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL.Scheme = target.Scheme
				req.URL.Host = target.Host
				req.URL.Path = fmt.Sprintf("/proxy/%s%s", sessionID, downstream)
				req.URL.RawQuery = r.URL.RawQuery
				req.Header.Set("X-Opencode-Directory", meta.Directory)
				req.Host = target.Host
			},
		}
		proxy.ServeHTTP(w, r)
	})
}
