#!/usr/bin/env sh
# Run wuDict the way the PXDict container will (Phase 0 spike helper).
#
#   scripts/spike/run-wudict.sh <wudict-binary> <data-dir> [wudict args…]   (default args: serve)
#
# <data-dir> gets the /data layout: dictionaries/, db/, .wudict/{config,data,state,home}.
# HOME must NOT be the data dir itself: wuDict treats an existing ~/.wudict as a legacy folder and
# tries to migrate it (see docs/wudict-notes.md, Q12).
set -eu
bin="${1:?usage: run-wudict.sh <wudict-binary> <data-dir> [args…]}"
data="${2:?usage: run-wudict.sh <wudict-binary> <data-dir> [args…]}"
shift 2
[ "$#" -eq 0 ] && set -- serve
mkdir -p "$data/dictionaries" "$data/db" "$data/.wudict/home"

export HOME="$data/.wudict/home"
export XDG_CONFIG_HOME="$data/.wudict/config"
export XDG_DATA_HOME="$data/.wudict/data"
export XDG_STATE_HOME="$data/.wudict/state"
export DICT_DIR="$data/dictionaries"
export DB_DIR="$data/db"
export AUTH=on
export AUTH_TOKEN="${AUTH_TOKEN:-spike-token}"
export SERVER_IP=127.0.0.1
export SERVER_PORT="${SERVER_PORT:-6888}"
export USE_CACHED="${USE_CACHED:-1}"
export NO_BROWSER=1
export VERBOSE="${VERBOSE:-1}"
exec "$bin" "$@"
