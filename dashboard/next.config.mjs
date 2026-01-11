/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Allow dev server access from reverse proxy (development only)
  // Replace with your actual dev proxy origins if needed, or remove in production
  allowedDevOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
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
