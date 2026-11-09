#!/usr/bin/env bash
set -euo pipefail
pet_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
unset ELECTRON_RUN_AS_NODE
cd -- "$pet_root"
exec "$pet_root/node_modules/electron/dist/electron" --ozone-platform=x11 "$pet_root" "$@"
