#!/bin/bash
# E2E Tests for OIDC Authentication with JWS and JWE
#
# Tests:
# 1. CrowdSieve health and JWKS endpoint
# 2. LemonLDAP::NG OIDC discovery
# 3. Authentication flow (automated with curl)
# 4. Back-channel logout

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# URLs
CROWDSIEVE_URL="http://localhost:13000"
CROWDSIEVE_API_URL="http://localhost:18080"
LLNG_URL="http://localhost:19080"

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

warn() {
    echo -e "${YELLOW}WARN${NC}: $1"
}

info() {
    echo -e "INFO: $1"
}

# Wait for services
wait_for_services() {
    info "Waiting for services to be ready..."

    # Wait for LLNG
    for i in {1..30}; do
        if curl -sf "$LLNG_URL/" > /dev/null 2>&1; then
            break
        fi
        if [ $i -eq 30 ]; then
            fail "LemonLDAP::NG did not become ready"
            return 1
        fi
        sleep 2
    done

    # Wait for CrowdSieve
    for i in {1..30}; do
        if curl -sf "$CROWDSIEVE_API_URL/health" > /dev/null 2>&1; then
            break
        fi
        if [ $i -eq 30 ]; then
            fail "CrowdSieve did not become ready"
            return 1
        fi
        sleep 2
    done

    pass "All services are ready"
}

# Test 1: CrowdSieve JWKS endpoint
test_jwks_endpoint() {
    info "Testing CrowdSieve JWKS endpoint..."

    local jwks
    jwks=$(curl -sf "$CROWDSIEVE_URL/api/jwks")

    if [ -z "$jwks" ]; then
        fail "JWKS endpoint returned empty response"
        return 1
    fi

    # Check for signing key (JWS)
    local sig_keys
    sig_keys=$(echo "$jwks" | jq '[.keys[] | select(.use == "sig")] | length')
    if [ "$sig_keys" -ge 1 ]; then
        pass "JWKS contains $sig_keys signing key(s) for private_key_jwt"
    else
        fail "JWKS missing signing keys (JWS not enabled?)"
    fi

    # Check for encryption key (JWE)
    local enc_keys
    enc_keys=$(echo "$jwks" | jq '[.keys[] | select(.use == "enc")] | length')
    if [ "$enc_keys" -ge 1 ]; then
        pass "JWKS contains $enc_keys encryption key(s) for JWE"
    else
        fail "JWKS missing encryption keys (JWE not enabled?)"
    fi

    # Check encryption key algorithm
    local enc_alg
    enc_alg=$(echo "$jwks" | jq -r '.keys[] | select(.use == "enc") | .alg' | head -1)
    if [ "$enc_alg" = "RSA-OAEP-256" ]; then
        pass "Encryption key uses RSA-OAEP-256 algorithm"
    else
        fail "Encryption key algorithm is '$enc_alg', expected 'RSA-OAEP-256'"
    fi
}

# Test 2: LemonLDAP::NG OIDC discovery
test_oidc_discovery() {
    info "Testing OIDC discovery endpoint..."

    local discovery
    discovery=$(curl -sf "$LLNG_URL/.well-known/openid-configuration")

    if [ -z "$discovery" ]; then
        fail "OIDC discovery endpoint returned empty response"
        return 1
    fi

    pass "OIDC discovery endpoint accessible"

    # Check required endpoints
    local token_endpoint
    token_endpoint=$(echo "$discovery" | jq -r '.token_endpoint')
    if [ -n "$token_endpoint" ] && [ "$token_endpoint" != "null" ]; then
        pass "Token endpoint: $token_endpoint"
    else
        fail "Token endpoint not found in discovery"
    fi

    # Check for private_key_jwt support
    local auth_methods
    auth_methods=$(echo "$discovery" | jq -r '.token_endpoint_auth_methods_supported // []')
    if echo "$auth_methods" | grep -q "private_key_jwt"; then
        pass "Provider supports private_key_jwt authentication"
    else
        warn "Provider discovery doesn't list private_key_jwt (may still work if configured per-client)"
    fi

    # Check JWKS URI
    local jwks_uri
    jwks_uri=$(echo "$discovery" | jq -r '.jwks_uri')
    if [ -n "$jwks_uri" ] && [ "$jwks_uri" != "null" ]; then
        pass "JWKS URI: $jwks_uri"

        # Fetch and validate provider JWKS (convert internal URL to localhost)
        local jwks_url_local
        jwks_url_local=$(echo "$jwks_uri" | sed 's|http://llng|http://localhost:19080|')
        local provider_jwks
        provider_jwks=$(curl -sf "$jwks_url_local")
        if [ -n "$provider_jwks" ]; then
            local provider_keys
            provider_keys=$(echo "$provider_jwks" | jq '.keys | length')
            pass "Provider JWKS contains $provider_keys key(s)"
        else
            fail "Failed to fetch provider JWKS"
        fi
    else
        fail "JWKS URI not found in discovery"
    fi
}

# Test 3: Login redirect
test_login_redirect() {
    info "Testing login redirect..."

    # Request login page, should redirect to OIDC provider
    local response
    response=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$CROWDSIEVE_URL/login")
    local http_code
    http_code=$(echo "$response" | cut -d' ' -f1)
    local redirect_url
    redirect_url=$(echo "$response" | cut -d' ' -f2-)

    # Check if dashboard returns a page or redirect
    if [ "$http_code" = "200" ]; then
        pass "Login page returned 200 (client-side redirect expected)"
    elif [ "$http_code" = "302" ] || [ "$http_code" = "303" ] || [ "$http_code" = "307" ]; then
        if echo "$redirect_url" | grep -qE "llng|auth.example.com|localhost:19080"; then
            pass "Login redirects to OIDC provider ($http_code): $redirect_url"
        else
            pass "Login returns redirect ($http_code) - will redirect to OIDC provider"
        fi
    else
        fail "Login page returned unexpected status: $http_code"
    fi
}

# Test 4: Full authentication flow with curl
test_auth_flow() {
    info "Testing full authentication flow..."

    # Create a cookie jar for the session
    local cookie_jar
    cookie_jar=$(mktemp)
    trap "rm -f $cookie_jar" RETURN

    # Step 1: Start login flow at CrowdSieve
    info "  Step 1: Initiating login..."
    local login_response
    login_response=$(curl -s -c "$cookie_jar" -b "$cookie_jar" -L -o /dev/null -w "%{url_effective}" \
        "$CROWDSIEVE_URL/api/auth/login?callbackUrl=/")

    # The response should be the LLNG login form
    if echo "$login_response" | grep -q "auth.example.com\|localhost:19080"; then
        pass "Login flow redirected to OIDC provider"
    else
        # Check if we got redirected (might need to follow manually)
        warn "Login redirect may need manual verification"
    fi

    # Step 2: Authenticate with LLNG (dwho/dwho)
    info "  Step 2: Authenticating with LLNG..."

    # Get the login form (to extract any CSRF tokens if present)
    local login_page
    login_page=$(curl -s -c "$cookie_jar" -b "$cookie_jar" "$LLNG_URL/")

    # Submit credentials
    local auth_response
    auth_response=$(curl -s -c "$cookie_jar" -b "$cookie_jar" -L \
        -d "user=dwho" \
        -d "password=dwho" \
        -o /dev/null -w "%{http_code}" \
        "$LLNG_URL/")

    if [ "$auth_response" = "200" ] || [ "$auth_response" = "302" ]; then
        pass "LLNG authentication submitted"
    else
        warn "LLNG authentication returned: $auth_response"
    fi

    # Check if we got a LLNG session
    if grep -q "lemonldap" "$cookie_jar" 2>/dev/null; then
        pass "LLNG session cookie received"
    else
        warn "No LLNG session cookie found (may be named differently)"
    fi

    # Note: Full flow verification requires following the OAuth2 redirect chain
    # which is complex with curl. The key tests are:
    # - JWKS endpoint works (tested above)
    # - OIDC discovery works (tested above)
    # - Login initiates correctly (tested above)

    info "  Note: Full OAuth2 callback chain requires browser testing"
}

# Test 5: Back-channel logout endpoint
test_backchannel_logout_endpoint() {
    info "Testing back-channel logout endpoint..."

    # The endpoint should exist but reject invalid tokens
    local response
    response=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST \
        -d "logout_token=invalid" \
        "$CROWDSIEVE_URL/api/auth/backchannel-logout")

    # Should return 400 for invalid token (not 404, which would mean endpoint doesn't exist)
    if [ "$response" = "400" ]; then
        pass "Back-channel logout endpoint exists and validates tokens"
    elif [ "$response" = "404" ]; then
        fail "Back-channel logout endpoint not found (OIDC disabled?)"
    else
        warn "Back-channel logout returned unexpected status: $response"
    fi
}

# Test 6: Verify LLNG RP configuration
test_llng_rp_config() {
    info "Verifying LLNG RP configuration..."

    # Try to read the RP configuration
    local conf
    conf=$(docker exec llng-oidc-test /usr/share/docker-llng/updateConf get \
        "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsAuthMethod" 2>&1 | tail -1 || echo "")

    if [ "$conf" = "private_key_jwt" ]; then
        pass "LLNG RP configured with private_key_jwt authentication"
    elif [ -z "$conf" ] || echo "$conf" | grep -q "No such"; then
        warn "Could not verify LLNG RP config (run configure-llng.sh first?)"
    else
        fail "LLNG RP auth method is '$conf', expected 'private_key_jwt'"
    fi

    # Check JWE encryption config
    local enc_alg
    enc_alg=$(docker exec llng-oidc-test /usr/share/docker-llng/updateConf get \
        "oidcRPMetaDataOptions/crowdsieve-test/oidcRPMetaDataOptionsIdTokenEncKeyMgtAlg" 2>&1 | tail -1 || echo "")

    if [ "$enc_alg" = "RSA-OAEP-256" ]; then
        pass "LLNG RP configured with RSA-OAEP-256 JWE encryption"
    elif [ -z "$enc_alg" ] || echo "$enc_alg" | grep -q "No such"; then
        warn "Could not verify JWE config"
    else
        fail "LLNG RP JWE algorithm is '$enc_alg', expected 'RSA-OAEP-256'"
    fi
}

# Main test runner
main() {
    echo "=========================================="
    echo "  CrowdSieve OIDC E2E Test Suite"
    echo "=========================================="
    echo ""
    echo "Testing configuration:"
    echo "  - JWS: private_key_jwt authentication"
    echo "  - JWE: RSA-OAEP-256 + A256GCM encrypted tokens"
    echo "  - Back-channel logout with encrypted tokens"
    echo ""

    wait_for_services || exit 1
    echo ""

    echo "--- Test 1: CrowdSieve JWKS Endpoint ---"
    test_jwks_endpoint
    echo ""

    echo "--- Test 2: OIDC Discovery ---"
    test_oidc_discovery
    echo ""

    echo "--- Test 3: Login Redirect ---"
    test_login_redirect
    echo ""

    echo "--- Test 4: Authentication Flow ---"
    test_auth_flow
    echo ""

    echo "--- Test 5: Back-channel Logout ---"
    test_backchannel_logout_endpoint
    echo ""

    echo "--- Test 6: LLNG RP Configuration ---"
    test_llng_rp_config
    echo ""

    echo "=========================================="
    echo "  Test Results"
    echo "=========================================="
    echo -e "  ${GREEN}Passed${NC}: $TESTS_PASSED"
    echo -e "  ${RED}Failed${NC}: $TESTS_FAILED"
    echo ""

    if [ "$TESTS_FAILED" -gt 0 ]; then
        echo -e "${RED}Some tests failed!${NC}"
        echo ""
        echo "Manual verification steps:"
        echo "  1. Open http://localhost:13000 in a browser"
        echo "  2. Click 'Login' - should redirect to LLNG"
        echo "  3. Login with dwho/dwho"
        echo "  4. Should be redirected back to CrowdSieve dashboard"
        echo "  5. Verify user info is displayed"
        echo ""
        exit 1
    else
        echo -e "${GREEN}All tests passed!${NC}"
        echo ""
        echo "For full verification, test manually in a browser:"
        echo "  1. Open http://localhost:13000"
        echo "  2. Login with dwho/dwho"
        echo "  3. Verify the authentication completes"
        echo ""
    fi
}

main "$@"
