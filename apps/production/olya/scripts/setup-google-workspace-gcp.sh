#!/usr/bin/env bash
set -euo pipefail

# Creates a GCP project with Gmail and Calendar APIs enabled,
# and an OAuth Desktop client for the google-workspace-mcp server.
#
# Prerequisites: gcloud CLI installed and authenticated as a
# Workspace admin for pingpoet.com.
#
# Usage:
#   ./setup-google-workspace-gcp.sh [project-id]

PROJECT_ID="${1:-pingpoet-olya-workspace}"

echo "Creating project ${PROJECT_ID}..."
gcloud projects create "${PROJECT_ID}" --name="Olya Workspace MCP" 2>/dev/null || echo "Project already exists, continuing."

gcloud config set project "${PROJECT_ID}"

echo "Enabling APIs..."
gcloud services enable gmail.googleapis.com
gcloud services enable calendar-json.googleapis.com

echo "Configuring OAuth consent screen..."
# Internal consent screen for Workspace org — no external review needed.
# gcloud alpha iap oauth-brands is the closest CLI equivalent but has
# limited support. If this fails, configure manually:
#   https://console.cloud.google.com/apis/credentials/consent?project=${PROJECT_ID}
# Set: Internal, app name "Olya Workspace MCP", support email olya@pingpoet.com,
# scopes: gmail.modify, gmail.send, calendar, calendar.events
gcloud alpha iap oauth-brands create \
  --application_title="Olya Workspace MCP" \
  --support_email="olya@pingpoet.com" 2>/dev/null || echo "OAuth brand may already exist or require manual setup — see URL above."

echo "Creating OAuth Desktop client..."
# The gcloud CLI for creating OAuth clients is limited. Create manually if this fails:
#   https://console.cloud.google.com/apis/credentials?project=${PROJECT_ID}
# Type: Desktop app, Name: olya-workspace-mcp
CLIENT_OUTPUT=$(gcloud alpha iap oauth-clients create \
  "projects/${PROJECT_ID}/brands/-" \
  --display_name="olya-workspace-mcp" 2>&1) || true

if echo "${CLIENT_OUTPUT}" | grep -q "name:"; then
  CLIENT_ID=$(echo "${CLIENT_OUTPUT}" | grep "name:" | sed 's/.*\///')
  CLIENT_SECRET=$(echo "${CLIENT_OUTPUT}" | grep "secret:" | awk '{print $2}')
  echo ""
  echo "=== OAuth Client Created ==="
  echo "Client ID:     ${CLIENT_ID}"
  echo "Client Secret: ${CLIENT_SECRET}"
else
  echo ""
  echo "Automated client creation may not be supported."
  echo "Create manually at: https://console.cloud.google.com/apis/credentials?project=${PROJECT_ID}"
  echo "  Type: Desktop app"
  echo "  Name: olya-workspace-mcp"
  echo ""
  echo "Then copy the Client ID and Client Secret."
fi

echo ""
echo "=== Next Steps ==="
echo "1. Clone and build the MCP server:"
echo "   git clone git@github.com:activescott/google-workspace-mcp.git"
echo "   cd google-workspace-mcp && git checkout feat/injected-credentials && npm install"
echo ""
echo "2. Run the one-time OAuth consent flow:"
echo "   WORKSPACE_CLIENT_ID=<client-id> WORKSPACE_CLIENT_SECRET=<client-secret> npm run auth-utils -- login"
echo "   Sign in as olya@pingpoet.com and grant access."
echo ""
echo "3. Save the credential JSON and fill in the template:"
echo "   cp apps/production/olya/env.secret.google-workspace.example \\"
echo "      apps/production/olya/.env.secret.google-workspace"
echo "   # Paste values, then encrypt:"
echo "   ./scripts/encrypt-env-files.sh apps/production/olya/.env.secret.google-workspace"
