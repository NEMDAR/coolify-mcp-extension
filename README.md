# NEMDAR Coolify MCP Extension

NEMDAR-owned Streamable HTTP MCP sidecar for Coolify write operations that are not exposed by Coolify's built-in MCP server.

## Tools

- `create_application`: creates a public or private-GitHub-App application.
- `update_application`: updates an allowlisted set of application fields.
- `set_domain`: replaces an application's complete domain list.

The extension calls Coolify's documented `/api/v1` endpoints. It does not patch the Coolify installation, so Coolify upgrades do not overwrite it.

## Required environment variables

| Variable | Purpose |
|---|---|
| `COOLIFY_BASE_URL` | Coolify instance URL, e.g. `https://panel.nemdar.tech` |
| `COOLIFY_API_TOKEN` | Coolify API token with the minimum abilities required to create and update applications |
| `MCP_API_KEY` | Separate high-entropy bearer key used by ChatGPT to authenticate to this MCP server |
| `PORT` | HTTP port; defaults to `3000` |

Never reuse the Coolify token as `MCP_API_KEY`, and never commit either value.

## Run locally

```bash
npm install
COOLIFY_BASE_URL=https://panel.nemdar.tech \
COOLIFY_API_TOKEN=replace-me \
MCP_API_KEY=replace-with-a-different-key \
npm start
```

Endpoints:

- `GET /health` — unauthenticated liveness probe.
- `POST /mcp` — MCP Streamable HTTP endpoint; requires `Authorization: Bearer <MCP_API_KEY>`.

## Coolify deployment

1. Create an application from this private GitHub repository.
2. Select the Dockerfile build pack and expose port `3000`.
3. Add the four environment variables above as runtime secrets.
4. Set the health check path to `/health`.
5. Assign a dedicated HTTPS hostname such as `coolify-mcp.nemdar.tech`.
6. Connect ChatGPT to `https://coolify-mcp.nemdar.tech/mcp` using `MCP_API_KEY`.

Keep the existing built-in `https://panel.nemdar.tech/mcp` connection for read and lifecycle tools; this extension supplies only the missing write tools.

## Security behavior

- Incoming MCP calls require a separate bearer key.
- Coolify credentials remain server-side and are never returned by tools.
- Tool schemas allowlist writable fields.
- Domain conflicts remain blocked unless `force_domain_override=true` is explicitly supplied.
- API calls time out after 30 seconds.
