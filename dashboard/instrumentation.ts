/**
 * Next.js instrumentation hook: runs once when the server starts, before any
 * request is handled. Used to check the authentication configuration.
 */
export async function register(): Promise<void> {
  // The Edge sandbox (middleware) calls register() too: check only once, in
  // the Node.js server process.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { checkAuthConfiguration } = await import('./lib/auth/startup');
  checkAuthConfiguration();
}
