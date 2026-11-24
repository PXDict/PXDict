package config

import (
	"strings"
	"testing"
)

func envFrom(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(envFrom(nil))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ListenAddr != DefaultListenAddr || cfg.DataDir != DefaultDataDir || cfg.PWADir != DefaultPWADir {
		t.Errorf("unexpected defaults: %+v", cfg)
	}
	if got := cfg.WudictURL.String(); got != DefaultWudictURL {
		t.Errorf("WudictURL = %q, want %q", got, DefaultWudictURL)
	}
}

func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr []string // substrings; empty means success
		check   func(t *testing.T, c *Config)
	}{
		{
			name: "overrides",
			env: map[string]string{
				"LISTEN_ADDR": "127.0.0.1:9000",
				"DATA_DIR":    "/tmp/pxdict/../pxdict-data/",
				"PWA_DIR":     "/srv/other",
				"WUDICT_URL":  "http://127.0.0.1:7000/",
			},
			check: func(t *testing.T, c *Config) {
				if c.ListenAddr != "127.0.0.1:9000" {
					t.Errorf("ListenAddr = %q", c.ListenAddr)
				}
				if c.DataDir != "/tmp/pxdict-data" {
					t.Errorf("DataDir = %q, want cleaned path", c.DataDir)
				}
				if got := c.WudictURL.String(); got != "http://127.0.0.1:7000" {
					t.Errorf("WudictURL = %q", got)
				}
			},
		},
		{name: "whitespace means default", env: map[string]string{"LISTEN_ADDR": "  "}},
		{name: "bad listen addr", env: map[string]string{"LISTEN_ADDR": "8080"}, wantErr: []string{"LISTEN_ADDR"}},
		{name: "relative data dir", env: map[string]string{"DATA_DIR": "data"}, wantErr: []string{"DATA_DIR"}},
		{name: "relative pwa dir", env: map[string]string{"PWA_DIR": "pwa/dist"}, wantErr: []string{"PWA_DIR"}},
		{name: "https wudict", env: map[string]string{"WUDICT_URL": "https://127.0.0.1:6888"}, wantErr: []string{"WUDICT_URL"}},
		{name: "wudict with path", env: map[string]string{"WUDICT_URL": "http://127.0.0.1:6888/x"}, wantErr: []string{"WUDICT_URL"}},
		{name: "wudict with credentials", env: map[string]string{"WUDICT_URL": "http://u:p@127.0.0.1:6888"}, wantErr: []string{"WUDICT_URL"}},
		{
			name:    "all errors reported",
			env:     map[string]string{"LISTEN_ADDR": "x", "DATA_DIR": "rel"},
			wantErr: []string{"LISTEN_ADDR", "DATA_DIR"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := Load(envFrom(tt.env))
			if len(tt.wantErr) > 0 {
				if err == nil {
					t.Fatalf("err = nil, want %q", tt.wantErr)
				}
				for _, want := range tt.wantErr {
					if !strings.Contains(err.Error(), want) {
						t.Errorf("err = %v, want containing %q", err, want)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if tt.check != nil {
				tt.check(t, cfg)
			}
		})
	}
}
