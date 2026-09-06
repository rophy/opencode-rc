// gateway/dashboard.go
package main

import (
	"context"
	"html/template"
	"net/http"
)

func setUserContext(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userContextKey, userID)
}

func DashboardSessionsHandler(registry *Registry) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := UserFromContext(r.Context())
		if userID == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		sessions := registry.Sessions(userID)
		if sessions == nil {
			sessions = []Session{}
		}
		marshalJSON(w, http.StatusOK, sessions)
	})
}

var dashboardTmpl = template.Must(template.New("dashboard").Parse(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>opencode-rc</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 2rem; }
    h1 { margin-bottom: 1.5rem; font-size: 1.5rem; }
    .sessions { display: grid; gap: 1rem; max-width: 600px; }
    .session { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; }
    .session a { color: #58a6ff; text-decoration: none; font-weight: 600; font-size: 1.1rem; }
    .session a:hover { text-decoration: underline; }
    .session .meta { color: #8b949e; font-size: 0.85rem; margin-top: 0.5rem; }
    .empty { color: #8b949e; }
  </style>
</head>
<body>
  <h1>opencode-rc</h1>
  <div id="sessions" class="sessions"><p class="empty">Loading...</p></div>
  <script>
    fetch('/gateway/sessions')
      .then(r => r.json())
      .then(sessions => {
        const el = document.getElementById('sessions');
        if (!sessions.length) {
          el.innerHTML = '<p class="empty">No active sessions. Run opencode-rc on your dev machine to get started.</p>';
          return;
        }
        el.innerHTML = sessions.map(s =>
          '<div class="session">' +
            '<a href="/s/' + s.id + '/">' + s.directory + '</a>' +
            '<div class="meta">Session ' + s.id.slice(0, 8) + ' &middot; ' + s.endpoint + '</div>' +
          '</div>'
        ).join('');
      });
  </script>
</body>
</html>`))

func DashboardHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		dashboardTmpl.Execute(w, nil)
	})
}
