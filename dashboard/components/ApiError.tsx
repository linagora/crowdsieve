'use client';

interface ApiErrorProps {
  type: 'no_api_key' | 'unauthorized' | 'connection_error';
  details?: string;
}

export function ApiError({ type, details }: ApiErrorProps) {
  const errors = {
    no_api_key: {
      title: 'API Key Not Configured',
      message:
        'The DASHBOARD_API_KEY environment variable is not set on the dashboard server. Please configure it to match the proxy API key.',
      icon: '🔑',
    },
    unauthorized: {
      title: 'API Key Rejected',
      message:
        'The dashboard API key was rejected by the proxy. Ensure DASHBOARD_API_KEY is set to the same value on both the dashboard and proxy servers.',
      icon: '🚫',
    },
    connection_error: {
      title: 'Cannot Connect to API',
      message:
        'Failed to connect to the CrowdSieve proxy API. Ensure the proxy is running and API_URL is correctly configured.',
      icon: '🔌',
    },
  };

  const error = errors[type];

  return (
    <div className="min-h-[400px] flex items-center justify-center p-8">
      <div className="max-w-md w-full bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 text-center">
        <div className="text-4xl mb-4">{error.icon}</div>
        <h2 className="text-xl font-semibold text-red-800 dark:text-red-200 mb-2">{error.title}</h2>
        <p className="text-red-700 dark:text-red-300 mb-4">{error.message}</p>
        {details && (
          <p className="text-sm text-red-600 dark:text-red-400 font-mono bg-red-100 dark:bg-red-900/40 p-2 rounded">
            {details}
          </p>
        )}
        <div className="mt-6 text-left text-sm text-red-700 dark:text-red-300">
          <p className="font-semibold mb-2">Configuration:</p>
          <code className="block bg-red-100 dark:bg-red-900/40 p-3 rounded text-xs">
            # On both dashboard and proxy servers:
            <br />
            export DASHBOARD_API_KEY=&quot;your-secret-key&quot;
          </code>
        </div>
      </div>
    </div>
  );
}
