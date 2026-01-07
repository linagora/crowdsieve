#!/bin/sh
set -e

echo "Starting CrowdSec Proxy services..."

# Start the proxy server in background
echo "Starting proxy on port ${PROXY_PORT:-8080}..."
node dist/index.js &
PROXY_PID=$!

# Start the dashboard
echo "Starting dashboard on port ${DASHBOARD_PORT:-3000}..."
cd dashboard && node .next/standalone/server.js &
DASHBOARD_PID=$!

# Handle shutdown
shutdown() {
  echo "Shutting down services..."
  kill $PROXY_PID 2>/dev/null || true
  kill $DASHBOARD_PID 2>/dev/null || true
  wait
  echo "All services stopped"
  exit 0
}

trap shutdown SIGTERM SIGINT

# Wait for both processes (POSIX-compatible)
wait $PROXY_PID $DASHBOARD_PID

# If any exits, stop all
shutdown
