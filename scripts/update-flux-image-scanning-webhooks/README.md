# Update Flux Image Scanning Webhooks

This script updates GitHub webhooks for Flux ImageRepositories in the cluster.

## What it does

1. **Discovers** all ImageRepositories in the cluster using `kubectl`
2. **Extracts** webhook configuration from the Flux receiver
3. **Verifies** existing webhooks in GitHub repositories
4. **Creates** or **updates** webhooks as needed

## Prerequisites

- `kubectl` configured with access to the cluster
- `GITHUB_TOKEN` environment variable with repo admin permissions
- Node.js/npm for running the TypeScript script

## Usage

```bash
# Install dependencies
cd scripts/update-flux-image-scanning-webhooks
npm install

# Set the GitHub token
export GITHUB_TOKEN="the_github_token_here"

# Run the script
npm start
# or directly:
./manage-webhooks.ts
```
