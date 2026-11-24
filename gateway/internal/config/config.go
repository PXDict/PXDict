// Package config loads the gateway configuration from environment variables, applies defaults and
// validates it. Phase 2 adds the remaining settings listed in docs/PLAN.md.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"strings"
)

// Config is the validated gateway configuration.
type Config struct {
	// ListenAddr is the address the gateway listens on (LISTEN_ADDR, default ":8080").
	ListenAddr string
	// DataDir is the root of the persistent volume (DATA_DIR, default "/data").
	DataDir string
	// WudictURL is the base URL of the loopback wuDict server
	// (WUDICT_URL, default "http://127.0.0.1:6888").
	WudictURL *url.URL
	// PWADir holds the built PWA served at "/" (PWA_DIR, default "/srv/pwa").
	PWADir string
}

// Defaults for every setting.
const (
	DefaultListenAddr = ":8080"
	DefaultDataDir    = "/data"
	DefaultWudictURL  = "http://127.0.0.1:6888"
	DefaultPWADir     = "/srv/pwa"
)

// Load reads the configuration through getenv (usually os.Getenv) and validates it.
// All problems are reported together.
func Load(getenv func(string) string) (*Config, error) {
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}

	var errs []error
	cfg := &Config{
		ListenAddr: get("LISTEN_ADDR", DefaultListenAddr),
		DataDir:    get("DATA_DIR", DefaultDataDir),
		PWADir:     get("PWA_DIR", DefaultPWADir),
	}

	if _, _, err := net.SplitHostPort(cfg.ListenAddr); err != nil {
		errs = append(errs, fmt.Errorf("LISTEN_ADDR %q: %w", cfg.ListenAddr, err))
	}
	if !filepath.IsAbs(cfg.DataDir) {
		errs = append(errs, fmt.Errorf("DATA_DIR %q: must be an absolute path", cfg.DataDir))
	}
	cfg.DataDir = filepath.Clean(cfg.DataDir)
	if !filepath.IsAbs(cfg.PWADir) {
		errs = append(errs, fmt.Errorf("PWA_DIR %q: must be an absolute path", cfg.PWADir))
	}
	cfg.PWADir = filepath.Clean(cfg.PWADir)

	raw := get("WUDICT_URL", DefaultWudictURL)
	u, err := url.Parse(raw)
	switch {
	case err != nil:
		errs = append(errs, fmt.Errorf("WUDICT_URL %q: %w", raw, err))
	case u.Scheme != "http" || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil:
		errs = append(errs, fmt.Errorf("WUDICT_URL %q: must be http://host:port with no path, query or credentials", raw))
	default:
		u.Path = ""
		cfg.WudictURL = u
	}

	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return cfg, nil
}
