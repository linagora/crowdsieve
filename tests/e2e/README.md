# CrowdSieve E2E Tests

This directory contains end-to-end tests for CrowdSieve features that require external services.

## OIDC Authentication Test

Tests the full OIDC authentication flow with:

- **JWS (private_key_jwt)**: Client authentication using signed JWT assertions
- **JWE (encrypted tokens)**: ID tokens and logout tokens encrypted with RSA-OAEP-256
- **Back-channel logout**: Server-to-server logout notification with encrypted tokens

### Prerequisites

- Docker and Docker Compose
- `jq` command-line tool (for JSON parsing in tests)
- `curl`

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         E2E Test Environment                             │
│                                                                          │
│  ┌──────────────────────┐          ┌──────────────────────┐             │
│  │   LemonLDAP::NG      │          │     CrowdSieve       │             │
│  │   (OIDC Provider)    │          │    (Dashboard)       │             │
│  │                      │          │                      │             │
│  │  auth.example.com    │◄────────►│ dashboard.example.com│             │
│  │  localhost:19080     │  OIDC    │ localhost:13000      │             │
│  │                      │          │                      │             │
│  │  • Signs ID tokens   │          │  • JWS auth          │             │
│  │  • Encrypts (JWE)    │          │  • Decrypts JWE      │             │
│  │  • Sends logout      │          │  • JWKS endpoint     │             │
│  └──────────────────────┘          └──────────────────────┘             │
│                                                                          │
│  Test User: dwho / dwho                                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Running the Tests

```bash
# 1. Start the test environment (OIDC is auto-configured via s6 init script)
cd tests/e2e
docker compose -f docker-compose.oidc.yaml up -d --build

# 2. Wait for services to be healthy
docker compose -f docker-compose.oidc.yaml ps

# 3. Run automated tests
./test-oidc.sh

# 4. (Optional) Manual browser test
# Open http://localhost:13000 and login with dwho/dwho

# 5. Cleanup
docker compose -f docker-compose.oidc.yaml down -v
```

Note: OIDC provider configuration is automatic via the s6 init script mounted at `/etc/cont-init.d/00-configure-oidc.sh`. The `configure-llng.sh` script is kept for manual testing/debugging.

### What Gets Tested

| Test                | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| JWKS Endpoint       | Verifies CrowdSieve publishes signing (JWS) and encryption (JWE) keys |
| OIDC Discovery      | Verifies LLNG provider discovery endpoint                             |
| Login Redirect      | Verifies login redirects to OIDC provider                             |
| Authentication Flow | Tests credential submission and OAuth2 flow                           |
| Back-channel Logout | Verifies endpoint exists and validates tokens                         |
| LLNG RP Config      | Verifies LLNG is configured with private_key_jwt and JWE              |

### Configuration

The test uses these settings:

| Setting                 | Value                   |
| ----------------------- | ----------------------- |
| OIDC Client ID          | `crowdsieve-test`       |
| Token Auth Method       | `private_key_jwt` (JWS) |
| ID Token Encryption     | RSA-OAEP-256 + A256GCM  |
| Logout Token Encryption | RSA-OAEP-256 + A256GCM  |
| Test User               | `dwho` / `dwho`         |

### Ports

| Service              | Port  | Description            |
| -------------------- | ----- | ---------------------- |
| LemonLDAP::NG        | 19080 | OIDC Provider (Portal) |
| CrowdSieve Dashboard | 13000 | Dashboard UI           |
| CrowdSieve API       | 18080 | Proxy API              |

### CI Integration

These tests run automatically in GitHub Actions CI. See `.github/workflows/ci.yml` for the `e2e-oidc` job.

### Manual Verification

For complete verification, test the flow manually:

1. Open http://localhost:13000 in a browser
2. Click the "Login" button
3. You should be redirected to LemonLDAP::NG (http://localhost:19080)
4. Enter credentials: `dwho` / `dwho`
5. After authentication, you should be redirected back to CrowdSieve
6. Verify you see the user's information in the dashboard

### Troubleshooting

**Services not starting:**

```bash
docker compose -f docker-compose.oidc.yaml logs
```

**LLNG configuration failed:**

```bash
# Check LLNG container logs
docker logs llng-oidc-test

# Verify LLNG is responding
curl http://localhost:19080/
```

**JWKS endpoint empty:**

```bash
# Check CrowdSieve environment
docker exec crowdsieve-oidc-test env | grep -E "JWS|JWE"

# Check logs
docker logs crowdsieve-oidc-test
```

**Authentication fails:**

```bash
# Check CrowdSieve can reach LLNG
docker exec crowdsieve-oidc-test curl -s http://auth.example.com/.well-known/openid-configuration

# Check LLNG can reach CrowdSieve JWKS
docker exec llng-oidc-test curl -s http://dashboard.example.com:3000/api/jwks
```

### Files

| File                             | Description                                         |
| -------------------------------- | --------------------------------------------------- |
| `docker-compose.oidc.yaml`       | Docker Compose configuration for test environment   |
| `llng-init/00-configure-oidc.sh` | s6 init script to auto-configure LLNG OIDC provider |
| `configure-llng.sh`              | Manual configuration script (for debugging)         |
| `test-oidc.sh`                   | Automated test script                               |
