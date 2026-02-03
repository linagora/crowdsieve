#!/command/with-contenv bash
# Configure LLNG OIDC provider at container init
# This script runs before the web service starts via s6 cont-init.d

set -e

echo "=== Configuring OIDC Provider for E2E Tests ==="

# Helper function to set LLNG config
set_conf() {
    local key="$1"
    local value="$2"
    echo "  Setting $key"
    /usr/share/docker-llng/updateConf set "$key" "$value"
}

# URLs within Docker network (container-to-container)
CROWDSIEVE_JWKS_URI="http://crowdsieve:3000/api/jwks"
CROWDSIEVE_BACKCHANNEL_LOGOUT_URI="http://crowdsieve:3000/api/auth/backchannel-logout"
# Redirect URI as seen by the browser (localhost with mapped port)
CROWDSIEVE_REDIRECT_URI="http://localhost:13000/api/auth/callback"

echo "1. Enabling OIDC Provider..."
set_conf "issuerDBOpenIDConnectActivation" "1"

echo "2. Generating OIDC signing keys..."
# Generate RSA key for OIDC signature
RSA_KEY=$(perl -e '
use Crypt::OpenSSL::RSA;
my $rsa = Crypt::OpenSSL::RSA->generate_key(2048);
print $rsa->get_private_key_string;
')
/usr/share/docker-llng/updateConf set oidcServicePrivateKeySig "$RSA_KEY"
echo "  Setting oidcServicePrivateKeySig"

# Set a key ID
KEY_ID="llng-sig-$(date +%s)"
set_conf "oidcServiceKeyIdSig" "$KEY_ID"

echo "3. Configuring OIDC Relying Party: crowdsieve-test..."

# Basic RP settings
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsClientID" "crowdsieve-test"
# No client secret for private_key_jwt
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsClientSecret" ""
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsDisplayName" "CrowdSieve Dashboard (E2E Test)"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsRedirectUris" "$CROWDSIEVE_REDIRECT_URI"

echo "4. Configuring private_key_jwt authentication (JWS)..."
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsAuthMethod" "private_key_jwt"

# JWKS URI for verifying client assertions and encrypting tokens
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsJwksUri" "$CROWDSIEVE_JWKS_URI"

# ID Token signature
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsIDTokenSignAlg" "RS256"

echo "5. Configuring JWE encryption for ID tokens..."
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsIdTokenEncKeyMgtAlg" "RSA-OAEP-256"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsIdTokenEncContentEncAlg" "A256GCM"

echo "6. Configuring back-channel logout..."
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutType" "back"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutUrl" "$CROWDSIEVE_BACKCHANNEL_LOGOUT_URI"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutSessionRequired" "1"

# JWE encryption for logout tokens
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutEncKeyMgtAlg" "RSA-OAEP-256"
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsLogoutEncContentEncAlg" "A256GCM"

# Bypass consent for testing
set_conf "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsBypassConsent" "1"

echo "7. Configuring exported claims..."
set_conf "oidcRPMetaDataExportedVars/crowdsieve-test/sub" "uid"
set_conf "oidcRPMetaDataExportedVars/crowdsieve-test/email" "mail"
set_conf "oidcRPMetaDataExportedVars/crowdsieve-test/name" "cn"

echo "=== OIDC Configuration Complete ==="
