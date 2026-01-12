# SearXNG

A privacy-respecting metasearch engine deployed as a private, authenticated instance.

## Overview

- **Image**: `searxng/searxng:2026.1.10-44405bd03`
- **Namespace**: `searxng-prod`
- **URL**: `https://sear.scott.willeke.com`
- **Authentication**: HTTP Basic Auth via Traefik middleware
- **Proxy**: OxyLabs residential proxy (US random IPs)

## Pre-Deployment Setup

### 1. Create Host Directories

Run this on the Kubernetes node:

```bash
ssh <node> 'sudo bash -s' < apps/production/searxng/setup-host-directories.sh
```

### 2. Create and Encrypt Secrets

```bash
cd apps/production/searxng

# Generate SearXNG secret and add OxyLabs proxy URL
cat > .env.secret.app << 'EOF'
SEARXNG_SECRET=<run: openssl rand -hex 32>
OXYLABS_PROXY_URL=http://customer-YOUR_USERNAME-cc-US:YOUR_PASSWORD@pr.oxylabs.io:7777
EOF

# Edit .env.secret.app to fill in actual values:
# - Generate SEARXNG_SECRET with: openssl rand -hex 32
# - Replace YOUR_USERNAME and YOUR_PASSWORD with OxyLabs credentials

# Generate htpasswd auth for Traefik basic auth
htpasswd -cb basic-auth-htpasswd YOUR_USERNAME YOUR_PASSWORD

# Encrypt both files using SOPS
sops --encrypt --in-place .env.secret.app
mv .env.secret.app .env.secret.app.encrypted

sops --encrypt --in-place basic-auth-htpasswd
mv basic-auth-htpasswd basic-auth-htpasswd.encrypted
```

### 3. DNS Setup

Ensure `sear.scott.willeke.com` points to your cluster's ingress IP.

### 4. Commit and Push

Flux will automatically deploy the changes.

## API Usage

### Authentication

All requests require HTTP Basic Auth:

```bash
curl -u "username:password" "https://sear.scott.willeke.com/search?q=test&format=json"
```

Or with Authorization header:

```bash
curl -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
  "https://sear.scott.willeke.com/search?q=test&format=json"
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/search` | GET/POST | Execute a search |
| `/healthz` | GET | Health check endpoint |

### Search Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `q` | Search query (required) | `test` |
| `format` | Output format: `json`, `csv`, `rss`, `html` | `json` |
| `categories` | Comma-separated categories | `general,images` |
| `engines` | Comma-separated engines | `google,duckduckgo` |
| `language` | Language code | `en-US` |
| `pageno` | Page number (default: 1) | `2` |
| `time_range` | Time filter: `day`, `month`, `year` | `month` |
| `safesearch` | Safe search: 0=off, 1=moderate, 2=strict | `1` |

### Example JSON Response

```json
{
  "query": "test",
  "number_of_results": 1234,
  "results": [
    {
      "title": "Result Title",
      "url": "https://example.com",
      "content": "Description snippet...",
      "engine": "google",
      "category": "general"
    }
  ]
}
```

## Verification

1. Check pod status:
   ```bash
   kubectl -n searxng-prod get pods
   ```

2. Check logs:
   ```bash
   kubectl -n searxng-prod logs -l app=app -f
   ```

3. Test health endpoint (from within cluster):
   ```bash
   kubectl -n searxng-prod run curl --rm -it --image=curlimages/curl -- \
     curl http://app:8080/healthz
   ```

4. Test API with port-forward:
   ```bash
   kubectl -n searxng-prod port-forward svc/app 8080:8080
   curl -u "username:password" "http://localhost:8080/search?q=test&format=json"
   ```

## Configuration

The SearXNG configuration is in `app-configmap.yaml`. Key settings:

- **JSON API**: Enabled via `formats: [html, json, csv, rss]`
- **Limiter**: Disabled (private instance)
- **Public instance**: Disabled
- **Image proxy**: Enabled
- **Outgoing proxy**: OxyLabs residential (US)

## Troubleshooting

### Proxy Issues

If searches are failing, check the OxyLabs proxy configuration:
- Verify credentials in the secret
- Check that `-cc-US` is correctly formatted in the username
- Test proxy connectivity from within the pod

### Certificate Issues

If TLS isn't working:
```bash
kubectl -n searxng-prod get certificate
kubectl -n searxng-prod describe certificate sear-scott-willeke-com
```

### Authentication Issues

If basic auth isn't working:
```bash
kubectl -n searxng-prod get secret basic-auth -o yaml
kubectl -n searxng-prod get middleware basic-auth -o yaml
```

## References

- [SearXNG Documentation](https://docs.searxng.org/)
- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)
- [OxyLabs Residential Proxies](https://developers.oxylabs.io/proxies/residential-proxies/making-requests)
- [Traefik BasicAuth Middleware](https://doc.traefik.io/traefik/middlewares/http/basicauth/)
