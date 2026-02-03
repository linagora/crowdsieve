import { redirect } from 'next/navigation';
import { isOidcEnabled } from '@/lib/oidc/config';
import { isSessionValid } from '@/lib/oidc/session';

// Regex to detect URL schemes (e.g., http:, https:, javascript:, data:)
const UNSAFE_URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// Validate redirect path to prevent open redirect attacks
function isSafeRedirect(path: string | undefined): path is string {
  if (!path) return false;
  // Reject any path that starts with a URL scheme
  if (UNSAFE_URL_SCHEME.test(path)) return false;
  // Must start with / (relative path) and not // (protocol-relative URL)
  return path.startsWith('/') && !path.startsWith('//');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirect?: string }>;
}) {
  // If OIDC is not enabled, redirect to home (no auth required)
  if (!isOidcEnabled()) {
    redirect('/');
  }

  // If already authenticated, redirect to home or requested page
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
                {error === 'invalid_state' && 'Invalid authentication state. Please try again.'}
                {error === 'no_claims' && 'Could not retrieve user information. Please try again.'}
                {error === 'callback_failed' && 'Authentication failed. Please try again.'}
                {!['invalid_state', 'no_claims', 'callback_failed'].includes(error) &&
                  'An error occurred during authentication.'}
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
