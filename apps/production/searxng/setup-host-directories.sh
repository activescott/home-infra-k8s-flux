#!/bin/bash
# setup-host-directories.sh
# Run this on the Kubernetes node before deploying
#
# Usage:
#   ssh <node> 'sudo bash -s' < setup-host-directories.sh

set -euo pipefail

searxng_base="/mnt/thedatapool/app-data/searxng"

echo "Creating SearXNG directories..."
mkdir -p "${searxng_base}/cache"

# SearXNG runs as UID 977 (searxng user in container)
echo "Setting ownership to UID 977 (searxng)..."
chown -R 977:977 "${searxng_base}"
chmod -R 755 "${searxng_base}"

echo "Created SearXNG directories at ${searxng_base}"
ls -la "${searxng_base}"
