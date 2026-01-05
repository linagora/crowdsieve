/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // API calls go to the proxy server
  async rewrites() {
    const proxyUrl = process.env.PROXY_URL || 'http://localhost:8080';
    return [
      {
        source: '/api/:path*',
        destination: `${proxyUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
