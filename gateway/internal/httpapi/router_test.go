package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRouter(t *testing.T) {
	srv := httptest.NewServer(NewRouter(Options{Version: "test"}))
	t.Cleanup(srv.Close)

	tests := []struct {
		name       string
		method     string
		path       string
		wantStatus int
		wantBody   string // substring
	}{
		{"healthz", http.MethodGet, "/healthz", http.StatusOK, `"status":"ok"`},
		{"healthz version", http.MethodGet, "/healthz", http.StatusOK, `"version":"test"`},
		{"healthz wrong method", http.MethodPost, "/healthz", http.StatusMethodNotAllowed, ""},
		{"unknown app-api", http.MethodGet, "/app-api/nope", http.StatusNotFound, `"code":"not_found"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(tt.method, srv.URL+tt.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tt.wantStatus {
				t.Errorf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(body), tt.wantBody) {
				t.Errorf("body = %q, want containing %q", body, tt.wantBody)
			}
		})
	}
}

func TestErrorShape(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, http.StatusTeapot, "some_code", "some message")
	if rec.Code != http.StatusTeapot {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "some_code" || body.Error.Message != "some message" {
		t.Errorf("body = %+v", body)
	}
}
