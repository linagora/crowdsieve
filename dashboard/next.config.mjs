/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Allow dev access from reverse proxy
  allowedDevOrigins: ['http://auth.example.com', 'https://auth.example.com'],
  // API calls go to the proxy server (except ip-info which has its own route)
  async rewrites() {
    const proxyUrl = process.env.PROXY_URL || 'http://localhost:8080';
    return [
      {
        source: '/api/alerts/:path*',
        destination: `${proxyUrl}/api/alerts/:path*`,
      },
      {
        source: '/api/stats',
        destination: `${proxyUrl}/api/stats`,
      },
    ];
  },
};

export default nextConfig;
