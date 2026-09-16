package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCoverageHandlerWithoutCoverBuild(t *testing.T) {
	handler := CoverageHandler()

	req := httptest.NewRequest("GET", "/debug/coverage", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// When not built with -cover, WriteMetaDir returns an error
	// and the handler responds with 404.
	if rec.Code != http.StatusNotFound {
		// If built with -cover (e.g. during coverage runs), it returns 200
		if rec.Code != http.StatusOK {
			t.Errorf("expected 404 (no -cover) or 200 (with -cover), got %d", rec.Code)
		}
	}
}
