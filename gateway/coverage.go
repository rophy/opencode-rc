package main

import (
	"archive/tar"
	"net/http"
	"os"
	"path/filepath"
	"runtime/coverage"
)

func CoverageHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dir, err := os.MkdirTemp("", "coverage-*")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer os.RemoveAll(dir)

		if err := coverage.WriteMetaDir(dir); err != nil {
			http.Error(w, "coverage not available (build with -cover): "+err.Error(), http.StatusNotFound)
			return
		}
		if err := coverage.WriteCountersDir(dir); err != nil {
			http.Error(w, "coverage counters: "+err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/x-tar")
		tw := tar.NewWriter(w)
		defer tw.Close()

		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			info, _ := e.Info()
			hdr, _ := tar.FileInfoHeader(info, "")
			hdr.Name = e.Name()
			tw.WriteHeader(hdr)
			data, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			tw.Write(data)
		}
	}
}
