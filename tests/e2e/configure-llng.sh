#!/bin/bash
# Configure LemonLDAP::NG as OIDC provider for CrowdSieve E2E test
#
# This script configures:
# - OIDC provider activation
# - A Relying Party (crowdsieve-test) with:
#   - private_key_jwt authentication (JWS)
#   - Encrypted ID tokens (JWE)
#   - Back-channel logout with encrypted tokens

set -e

CONTAINER="llng-oidc-test"
# URLs within Docker network (container-to-container)
CROWDSIEVE_JWKS_URI="http://crowdsieve:3000/api/jwks"
CROWDSIEVE_BACKCHANNEL_LOGOUT_URI="http://crowdsieve:3000/api/auth/backchannel-logout"
# Redirect URI as seen by the browser (localhost with mapped port)
CROWDSIEVE_REDIRECT_URI="http://localhost:13000/api/auth/callback"

echo "=== Configuring LemonLDAP::NG for OIDC E2E Test ==="

# Wait for LLNG to be ready
echo "Waiting for LLNG to be ready..."
for i in {1..30}; do
    if docker exec "$CONTAINER" curl -sf http://localhost/ > /dev/null 2>&1; then
        echo "LLNG is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "ERROR: LLNG did not become ready in time"
        exit 1
    fi
    sleep 2
done

# Helper function to set LLNG config
set_conf() {
    local key="$1"
    local value="$2"
    echo "  Setting $key"
    docker exec "$CONTAINER" /usr/share/docker-llng/updateConf set "$key" "$value"
}

echo ""
echo "1. Enabling OIDC Provider..."
set_conf "issuerDBOpenIDConnectActivation" "1"

echo ""
echo "2. Generating OIDC signing keys..."
# Generate RSA key for OIDC signature
RSA_KEY=$(docker exec "$CONTAINER" perl -e '
use Crypt::OpenSSL::RSA;
my $rsa = Crypt::OpenSSL::RSA->generate_key(2048);
print $rsa->get_private_key_string;
')
# Set the key (base64 encode to avoid newline issues)
docker exec "$CONTAINER" /usr/share/docker-llng/updateConf set oidcServicePrivateKeySig "$RSA_KEY"
echo "  Setting oidcServicePrivateKeySig"

# Set a key ID
KEY_ID="llng-sig-$(date +%s)"
set_conf "oidcServiceKeyIdSig" "$KEY_ID"

echo ""
echo "3. Configuring OIDC Relying Party: crowdsieve-test..."

# Basic RP settings
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsClientID" "crowdsieve-test"
# No client secret for private_key_jwt
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsClientSecret" ""
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsDisplayName" "CrowdSieve Dashboard (E2E Test)"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsRedirectUris" "$CROWDSIEVE_REDIRECT_URI"

# Authentication method: private_key_jwt
echo ""
echo "4. Configuring private_key_jwt authentication (JWS)..."
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsAuthMethod" "private_key_jwt"

# JWKS URI for verifying client assertions and encrypting tokens
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsJwksUri" "$CROWDSIEVE_JWKS_URI"

# ID Token signature
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsIDTokenSignAlg" "RS256"

# JWE encryption for ID tokens
echo ""
echo "5. Configuring JWE encryption for ID tokens..."
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsIdTokenEncKeyMgtAlg" "RSA-OAEP-256"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsIdTokenEncContentEncAlg" "A256GCM"

# Back-channel logout
echo ""
echo "6. Configuring back-channel logout..."
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutType" "back"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutUrl" "$CROWDSIEVE_BACKCHANNEL_LOGOUT_URI"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutSessionRequired" "1"

# JWE encryption for logout tokens
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutEncKeyMgtAlg" "RSA-OAEP-256"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutEncContentEncAlg" "A256GCM"

# Bypass consent for testing
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsBypassConsent" "1"

# Export standard claims
echo ""
echo "7. Configuring exported claims..."
set_conf "oidcRPMetaDataExportedVars/crowdsieve-test/sub" "uid"
set_conf "oidcRPMetaDataExportedVars/crowdsieve-test/email" "mail"
set_conf "oidcRPMetaDataExportedVars/crowdsieve-test/name" "cn"

echo ""
echo "=== Configuration Complete ==="
echo ""
echo "OIDC Provider:"
echo "  - Internal (container): http://llng"
echo "  - External (browser):   http://localhost:19080"
echo ""
echo "Client ID: crowdsieve-test"
echo "Authentication: private_key_jwt (no client secret)"
echo "ID Token Encryption: RSA-OAEP-256 + A256GCM"
echo "Logout Token Encryption: RSA-OAEP-256 + A256GCM"
echo ""
echo "Test user: dwho / dwho"
echo ""
echo "To verify the JWKS endpoint:"
echo "  curl http://localhost:13000/api/jwks | jq"
echo ""
echo "To verify OIDC discovery:"
echo "  curl http://localhost:19080/.well-known/openid-configuration | jq"
