#!/bin/bash
#
# Builds the CrowdSieve image start.sh runs, from the working tree, with the release Dockerfile
# (proxy + dashboard), and pulls the CrowdSec and Dex images.
#
#   scripts/qa-environment/build.sh    # once, and whenever the code under test changes
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# host network: the dashboard build fetches its font from Google Fonts (next/font), which the
# default bridge network fails to reach on some hosts
docker build --network host -t crowdsieve-qa -f "$REPO_DIR/Dockerfile" "$REPO_DIR"

# Pinned tags: a local copy is as good when the registry does not answer
for image in crowdsecurity/crowdsec:v1.6.8 ghcr.io/dexidp/dex:v2.41.1; do
  docker pull -q "$image" || docker image inspect "$image" >/dev/null
done
