/**
 * Get API configuration at runtime.
 * IMPORTANT: This must be called inside functions, not at module level,
 * to ensure environment variables are read at runtime (not build time)
 * in Next.js standalone mode.
 */
export function getApiConfig() {
  return {
    apiBase: process.env.API_URL || 'http://localhost:8080',
    apiKey: process.env.DASHBOARD_API_KEY,
  };
}

export function getApiHeaders(): HeadersInit {
  const { apiKey } = getApiConfig();
  const headers: HeadersInit = {};
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  return headers;
}
