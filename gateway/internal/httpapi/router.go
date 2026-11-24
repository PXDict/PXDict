// Package httpapi wires the gateway's HTTP routes: the /app-api handlers, the wuDict proxy and the
// static PWA.
package httpapi

import (
	"net/http"
)

// Options are the dependencies of the router.
type Options struct {
	// Version is reported by /healthz.
	Version string
}

// HealthResponse is the body of GET /healthz.
type HealthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

// NewRouter returns the gateway's root handler.
func NewRouter(opts Options) http.Handler {
	mux := http.NewServeMux()

	// Phase 2 adds the wuDict check; until then the gateway reports only itself.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, HealthResponse{Status: "ok", Version: opts.Version})
	})

	mux.HandleFunc("/app-api/", func(w http.ResponseWriter, _ *http.Request) {
		WriteError(w, http.StatusNotFound, "not_found", "no such endpoint")
	})

	return mux
}
