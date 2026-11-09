#!/usr/bin/env bash
set -euo pipefail
pet_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export DWORLD_PET_LINK_FILE="${DWORLD_PET_LINK_FILE:-$pet_root/../data/production/desktop-link/remote-link.json}"
exec node "$pet_root/link-server.mjs"
