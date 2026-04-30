import { redirect } from 'next/navigation';
import { isOidcEnabled } from '@/lib/oidc/config';
import { isSessionValid } from '@/lib/oidc/session';
import { isSafeRedirect } from '@/lib/oidc/validation';
import { getAuthMode } from '@/lib/auth/mode';
import { getExternalLoginUrl } from '@/lib/auth/logout';

// Force dynamic rendering - auth config is only available at runtime
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirect?: string }>;
}) {
  const mode = getAuthMode();

  // Headers mode: this page acts as a static "Authentication required" UI.
  // We do NOT initiate any login flow — the upstream proxy handles auth.
  if (mode === 'headers') {
    if (await isSessionValid()) {
      const params = await searchParams;
      redirect(isSafeRedirect(params.redirect) ? params.redirect : '/');
    }

    const externalLogin = getExternalLoginUrl();

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="max-w-md w-full mx-4">
          <div className="bg-white rounded-lg shadow-lg p-8">
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-gray-900">CrowdSieve</h1>
              <p className="text-gray-600 mt-2">Authentication required</p>
            </div>

            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-amber-800 text-sm">
                This dashboard is configured to authenticate via an upstream proxy. Please ensure
                you are accessing it through your organization&apos;s portal.
              </p>
            </div>

            {externalLogin && (
              <a
                href={externalLogin}
                className="block w-full bg-crowdsec-primary text-white text-center py-3 px-4 rounded-lg hover:bg-crowdsec-primary/90 transition-colors font-medium"
              >
                Go to login portal
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 'none' mode: nothing to gate, send the user home.
  if (mode === 'none' || !isOidcEnabled()) {
    redirect('/');
  }

  // OIDC mode: existing behavior.
  if (await isSessionValid()) {
    const params = await searchParams;
    redirect(isSafeRedirect(params.redirect) ? params.redirect : '/');
  }

  const params = await searchParams;
  const error = params.error;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="max-w-md w-full mx-4">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-gray-900">CrowdSieve</h1>
            <p className="text-gray-600 mt-2">Sign in to access the dashboard</p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 text-sm">
                {error === 'invalid_state' &&
                  'Invalid authentication state (AUTH_INVALID_STATE). Your sign-in session may have expired. Please try again.'}
                {error === 'no_claims' &&
                  'Could not retrieve user information from the identity provider (AUTH_NO_CLAIMS). Please try again or contact your administrator.'}
                {error === 'callback_failed' &&
                  'Authentication callback failed (AUTH_CALLBACK_FAILED). Please try again. If the problem persists, check the server logs.'}
                {!['invalid_state', 'no_claims', 'callback_failed'].includes(error) &&
                  `Authentication error (${error}). Please try again or contact your administrator.`}
              </p>
            </div>
          )}

          <a
            href="/api/auth/login"
            className="block w-full bg-crowdsec-primary text-white text-center py-3 px-4 rounded-lg hover:bg-crowdsec-primary/90 transition-colors font-medium"
          >
            Sign in with SSO
          </a>

          <p className="text-center text-gray-500 text-sm mt-6">
            You will be redirected to your organization&apos;s login page
          </p>
        </div>
      </div>
    </div>
  );
}
