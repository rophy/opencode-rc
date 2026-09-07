// gateway/webui.go
package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func WebUIHandler(webUIDir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// URL: /s/{sessionID}/... (the /s/{sessionID} prefix is already stripped by the caller)
		// Serve static files; fall back to index.html for SPA routing.
		path := r.URL.Path
		if path == "" || path == "/" {
			path = "/index.html"
		}

		filePath := filepath.Join(webUIDir, filepath.Clean(path))
		if _, err := os.Stat(filePath); err != nil {
			// SPA fallback
			filePath = filepath.Join(webUIDir, "index.html")
		}

		http.ServeFile(w, r, filePath)
	})
}

func SessionWebUIOrProxy(registry *Registry, webUIDir string) http.Handler {
	proxy := ProxyHandler(registry)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !strings.HasPrefix(path, "/s/") {
			http.NotFound(w, r)
			return
		}

		rest := path[len("/s/"):]
		slashIdx := strings.Index(rest, "/")
		if slashIdx < 0 {
			// Redirect /s/sessionID to /s/sessionID/
			http.Redirect(w, r, path+"/", http.StatusFound)
			return
		}

		sessionID := rest[:slashIdx]
		subpath := rest[slashIdx:]

		// Check session exists
		_, ok := registry.Lookup(sessionID)
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		// Serve web UI for root path and static assets that exist on disk
		if webUIDir != "" {
			if subpath == "/" {
				r.URL.Path = subpath
				WebUIHandler(webUIDir).ServeHTTP(w, r)
				return
			}
			filePath := filepath.Join(webUIDir, filepath.Clean(subpath))
			if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
				r.URL.Path = subpath
				WebUIHandler(webUIDir).ServeHTTP(w, r)
				return
			}
		}

		// Proxy everything else to the dev machine (covers /api/, /global/, /session/, /pty, etc.)
		proxy.ServeHTTP(w, r)
	})
}
