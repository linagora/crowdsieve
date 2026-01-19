#!/bin/bash
# Download DB-IP City Lite database (CC BY 4.0)
# Run monthly to keep the database up to date
# https://db-ip.com/db/lite.php

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${GEOIP_DATA_DIR:-$SCRIPT_DIR/../data}"
OUTPUT_FILE="$DATA_DIR/geoip-city.mmdb"
YEAR_MONTH=$(date +%Y-%m)
URL="https://download.db-ip.com/free/dbip-city-lite-${YEAR_MONTH}.mmdb.gz"

mkdir -p "$DATA_DIR"

echo "Downloading DB-IP City Lite ($YEAR_MONTH)..."
echo "URL: $URL"

if curl -fSL "$URL" | gunzip > "$OUTPUT_FILE.tmp"; then
    mv "$OUTPUT_FILE.tmp" "$OUTPUT_FILE"
    echo "Downloaded successfully: $OUTPUT_FILE ($(du -h "$OUTPUT_FILE" | cut -f1))"
else
    rm -f "$OUTPUT_FILE.tmp"
    echo "Error: Download failed" >&2
    exit 1
fi
