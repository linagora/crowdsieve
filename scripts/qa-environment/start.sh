#!/bin/bash
#
# Starts a long lived CrowdSieve + CrowdSec LAPI + Dex stack for manual or agent driven exploratory
# QA. The CrowdSec LAPI gets a bouncer key and a machine for CrowdSieve (decision search, manual
# bans) and a few active decisions; CrowdSieve gets the alerts and bouncer metrics a LAPI would
# relay to CAPI (seed/seed.sh). Forwarding to CAPI is off: nothing leaves the stack.
#
#   scripts/qa-environment/build.sh    # once, and whenever the code under test changes
#   scripts/qa-environment/start.sh
#
# Accounts (Dex, password "secret"): alice@example.com, bob@example.com, carol@example.com. The
# dashboard has no roles: every signed in user may do everything.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GENERATED_DIR="$SCRIPT_DIR/.generated"

QA_PROJECT="${QA_PROJECT:-crowdsieve-qa}"
export QA_APP_PORT="${QA_APP_PORT:-18710}"
export QA_PROXY_PORT="${QA_PROXY_PORT:-18711}"
export QA_SSO_PORT="${QA_SSO_PORT:-18712}"
export QA_BOUNCER_KEY="${QA_BOUNCER_KEY:-qa-bouncer-key-0123456789abcdef}"
export QA_MACHINE_PASSWORD="${QA_MACHINE_PASSWORD:-qa-machine-password-0123456789}"
export QA_DASHBOARD_API_KEY="${QA_DASHBOARD_API_KEY:-qa-dashboard-api-key-0123456789abcdef}"

APP_URL="http://localhost:$QA_APP_PORT"
PROXY_URL="http://localhost:$QA_PROXY_PORT"

compose() {
  docker compose -p "$QA_PROJECT" -f "$SCRIPT_DIR/docker-compose.yaml" "$@"
}

wait_for() {
  local what="$1" service="$2"
  shift 2
  for _ in $(seq 1 90); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "$what did not start within 3 minutes, see: docker compose -p $QA_PROJECT logs $service" >&2
  exit 1
}

if ! docker image inspect crowdsieve-qa >/dev/null 2>&1; then
  echo "The crowdsieve-qa image is missing, build it first: scripts/qa-environment/build.sh" >&2
  exit 1
fi

# Every start begins from scratch: the seed is the only data
compose down --volumes --remove-orphans >/dev/null 2>&1 || true

echo "==> Generating the configuration in $GENERATED_DIR"
mkdir -p "$GENERATED_DIR"
if [ ! -s "$GENERATED_DIR/sso.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=sso" \
    -addext "subjectAltName=DNS:sso,DNS:localhost" -addext "basicConstraints=critical,CA:TRUE" \
    -keyout "$GENERATED_DIR/sso.key" -out "$GENERATED_DIR/sso.crt" 2>/dev/null
fi
# Read by Dex, which does not run as the owner of the file
chmod 644 "$GENERATED_DIR/sso.key" "$GENERATED_DIR/sso.crt"

cat > "$GENERATED_DIR/dex.yaml" <<DEX
issuer: https://sso:$QA_SSO_PORT
storage:
  type: memory
web:
  https: 0.0.0.0:$QA_SSO_PORT
  tlsCert: /etc/dex/tls.crt
  tlsKey: /etc/dex/tls.key
oauth2:
  skipApprovalScreen: true
  responseTypes: [code]
staticClients:
  - id: crowdsieve-dashboard
    name: CrowdSieve
    secret: qa-client-secret-qa-client-secret
    redirectURIs:
      - $APP_URL/api/auth/callback
enablePasswordDB: true
# Password "secret" for everyone
staticPasswords:
  - email: alice@example.com
    hash: "\$2a\$10\$0CcfMuNCSfCON9C9CWK38.UXYts5JZ4vUNNMf8G6kDSlsUivO0BMu"
    username: alice
    userID: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01
  - email: bob@example.com
    hash: "\$2a\$10\$0CcfMuNCSfCON9C9CWK38.UXYts5JZ4vUNNMf8G6kDSlsUivO0BMu"
    username: bob
    userID: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb02
  - email: carol@example.com
    hash: "\$2a\$10\$0CcfMuNCSfCON9C9CWK38.UXYts5JZ4vUNNMf8G6kDSlsUivO0BMu"
    username: carol
    userID: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb03
DEX

# ${...} is interpolated by CrowdSieve from the environment of docker-compose.yaml
cat > "$GENERATED_DIR/filters.yaml" <<'YAML'
proxy:
  listen_port: 8080
  capi_url: 'http://capi.invalid'
  timeout_ms: 5000
  forward_enabled: false

storage:
  path: '/app/data/crowdsieve.db'
  retention_days: 30

filters:
  mode: 'block'

lapi_servers:
  - name: 'lapi-qa'
    url: 'http://crowdsec:8080'
    api_key: '${LAPI_BOUNCER_KEY}'
    machine_id: 'crowdsieve'
    password: '${LAPI_MACHINE_PASSWORD}'
    source_machine_ids: ['qa-agent', 'qa-agent-2']

bouncer_metrics:
  retention_days: 30
YAML

echo "==> Starting the CrowdSec LAPI and Dex as compose project '$QA_PROJECT'"
compose up -d crowdsec sso

echo "==> Waiting for the CrowdSec LAPI"
wait_for "The CrowdSec LAPI" crowdsec compose exec -T crowdsec cscli lapi status

echo "==> Provisioning the LAPI"
compose exec -T crowdsec cscli machines add crowdsieve --password "$QA_MACHINE_PASSWORD" -f /dev/null --force >/dev/null 2>&1
for decision in "--ip 203.0.113.7 --duration 4h --reason qa-seed-http-probing" \
  "--ip 198.51.100.23 --duration 24h --reason qa-seed-ssh-bf" \
  "--range 192.0.2.0/28 --duration 12h --reason qa-seed-range --type captcha"; do
  # shellcheck disable=SC2086
  compose exec -T crowdsec cscli decisions add $decision >/dev/null 2>&1
done

echo "==> Starting CrowdSieve"
compose up -d crowdsieve

echo "==> Waiting for CrowdSieve"
wait_for "The CrowdSieve proxy" crowdsieve curl -sf "$PROXY_URL/health"
wait_for "The CrowdSieve dashboard" crowdsieve curl -sf -o /dev/null "$APP_URL/login"

echo "==> Seeding the alerts and bouncer metrics"
"$SCRIPT_DIR/seed/seed.sh" "$PROXY_URL"

cat <<INFO

==> The QA environment is up

  Dashboard: $APP_URL  (sign in through Dex, password "secret")
             alice@example.com, bob@example.com, carol@example.com
  Proxy:     $PROXY_URL  (CAPI side: /v2/signals, /v3/usage-metrics; REST API: /api/*,
             header X-API-Key: $QA_DASHBOARD_API_KEY)
  Dex:       https://sso:$QA_SSO_PORT  (self-signed; from a browser on the host: add "127.0.0.1 sso" to /etc/hosts)
  LAPI:      http://crowdsec:8080 on the stack network only (lapi-qa in the dashboard)

From a container (e.g. Playwright), join the network '${QA_PROJECT}_default' and use:
  --host-resolver-rules="MAP localhost:$QA_APP_PORT crowdsieve:3000,MAP localhost:$QA_PROXY_PORT crowdsieve:8080" --ignore-certificate-errors

Stop it with: scripts/qa-environment/stop.sh
INFO
