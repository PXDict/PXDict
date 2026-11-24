// Package migrations holds the gateway's numbered SQL migrations (NNNN_name.sql). They are embedded
// into the binary and applied in order by internal/store. Migrations are append-only: never edit one
// that has been released.
package migrations
