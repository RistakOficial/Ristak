# External API Access

Ristak exposes token-protected endpoints under `/api/external` for authorized external systems.

This document covers the customer-facing external API and MCP exposed by an
installed Ristak app. Internal support access for agents lives in Ristak
Installer; use `docs/support-mcp-operations.md` when Raul asks to inspect a
customer account, logs, chats, database rows, or production errors.

## Identity model

- `App ID` identifies this Ristak instance and is safe to share with integration partners.
- `API token` is the secret credential and must be handled like a password.
- Each authenticated Ristak user can have one active API token.
- Tokens are opaque secrets generated with `crypto.randomBytes(32)`.
- The database stores only the SHA-256 hash, prefix, last four characters, creation time, last-used time, and revocation time.
- Rotation immediately invalidates the previous token.
- Revocation clears the stored hash and disables external access for that user.

## Setup

1. Go to `Configuración > Acceso API`.
2. Copy the `App ID`.
3. Generate or rotate the API token and copy it immediately.
4. Send requests with:

   ```http
   Authorization: Bearer ristak_live_...
   ```

5. Use the schema URL if the external client supports OpenAPI:

   ```text
   https://YOUR_RENDER_DOMAIN/api/external/openapi.json
   ```

6. Use this MCP server URL if the external client expects MCP instead of OpenAPI:

   ```text
   https://YOUR_RENDER_DOMAIN/api/mcp
   ```

   MCP clients that require OAuth should use the built-in OAuth discovery endpoints. The authorization screen asks for a Ristak API token and exchanges it for OAuth access credentials.

## Available endpoints

### Credential management

- `GET /api/api-access`
- `POST /api/api-access/token/rotate`
- `DELETE /api/api-access/token`

### MCP and OAuth

- `POST /api/mcp`
- `GET /api/mcp`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /api/oauth/register`
- `GET /api/oauth/authorize`
- `POST /api/oauth/authorize`
- `POST /api/oauth/token`

### External data API

- `GET /api/external/me`
- `GET /api/external/dashboard/metrics`
- `GET /api/external/dashboard/funnel`
- `GET /api/external/dashboard/traffic-sources`
- `GET /api/external/reports/summary`
- `GET /api/external/reports/metrics`
- `GET /api/external/reports/contacts`
- `GET /api/external/reports/payments`
- `GET /api/external/reports/campaigns`
- `GET /api/external/reports/contacts/list`
- `GET /api/external/reports/transactions`
- `GET /api/external/contacts`
- `GET /api/external/contacts/search`
- `GET /api/external/contacts/{id}`
- `GET /api/external/contacts/{id}/conversation`
- `GET /api/external/contacts/{id}/journey`
- `GET /api/external/transactions`
- `GET /api/external/transactions/stats`
- `GET /api/external/transactions/summary`
- `GET /api/external/transactions/{id}`

## Render notes

- Keep HTTPS enabled.
- Set a strong `JWT_SECRET`; the web session still uses JWT.
- Never put generated API tokens in logs, build env vars, docs, screenshots, or GitHub issues.
- If a token leaks, rotate it from `Configuración > Acceso API`.
