# Build stage for proxy
FROM node:20-alpine AS proxy-builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy and build proxy
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --outDir dist

# Build stage for dashboard
FROM node:20-alpine AS dashboard-builder

WORKDIR /app/dashboard

# Install dashboard dependencies
COPY dashboard/package.json ./
RUN npm install

# Copy dashboard source
COPY dashboard ./

# Set API URL for build time
ENV PROXY_URL=http://localhost:8080
ENV API_URL=http://localhost:8080

# Build dashboard
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

RUN apk add --no-cache tini

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 crowdsec

# Install production dependencies for proxy
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force && \
    rm -rf /root/.npm && \
    find node_modules -type f \( \
        -name "README*" -o \
        -name "CHANGELOG*" -o \
        -name "*.md" -o \
        -name "*.map" \
    \) -delete && \
    find node_modules -type d \( \
        -name "test" -o \
        -name "tests" -o \
        -name ".github" -o \
        -name "docs" \
    \) -exec rm -rf {} + 2>/dev/null || true

# Copy proxy build
COPY --from=proxy-builder /app/dist ./dist
COPY config ./config

# Copy dashboard standalone build
COPY --from=dashboard-builder /app/dashboard/.next/standalone ./dashboard/.next/standalone
COPY --from=dashboard-builder /app/dashboard/.next/static ./dashboard/.next/standalone/.next/static
COPY --from=dashboard-builder /app/dashboard/public ./dashboard/.next/standalone/public

# Copy start script
COPY scripts/start.sh ./start.sh
RUN chmod +x ./start.sh

# Create data directory
RUN mkdir -p /app/data && chown -R crowdsec:nodejs /app

# Switch to non-root user
USER crowdsec

# Environment variables
ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config/filters.yaml
ENV DATABASE_PATH=/app/data/crowdsieve.db
ENV GEOIP_DB_PATH=/app/data/GeoLite2-City.mmdb
ENV PROXY_PORT=8080
ENV DASHBOARD_PORT=3000
ENV HOSTNAME=0.0.0.0

# Expose ports
EXPOSE 8080 3000

# Volume for persistent data
VOLUME ["/app/data"]

# Health check on proxy
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start both services
CMD ["./start.sh"]
