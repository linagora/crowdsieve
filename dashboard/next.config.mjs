/** @type {import('next').NextConfig} */
// Defence in depth against XSS and clickjacking. Next.js needs inline scripts
// (no nonces here); Leaflet needs OpenStreetMap tiles and data: marker images.
const contentSecurityPolicy = [
  "default-src 'self'",
  // `next dev` needs eval() for Fast Refresh; production builds do not.
  process.env.NODE_ENV === 'development'
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const nextConfig = {
  output: 'standalone',
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Allow dev server access from reverse proxy (development only)
  // Replace with your actual dev proxy origins if needed, or remove in production
  allowedDevOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
};

export default nextConfig;
