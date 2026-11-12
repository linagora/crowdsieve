#!/bin/bash
#
# Stops the QA environment started by start.sh and drops its volumes: the data is gone.
#
#   scripts/qa-environment/stop.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

QA_PROJECT="${QA_PROJECT:-crowdsieve-qa}"

# compose interpolates the whole file even to stop it
export QA_APP_PORT=1 QA_PROXY_PORT=1 QA_SSO_PORT=1 QA_BOUNCER_KEY=x QA_MACHINE_PASSWORD=x QA_DASHBOARD_API_KEY=x
docker compose -p "$QA_PROJECT" -f "$SCRIPT_DIR/docker-compose.yaml" down --volumes --remove-orphans
echo "==> QA environment '$QA_PROJECT' stopped"
