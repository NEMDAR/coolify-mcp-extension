import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as z from 'zod/v4';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const COOLIFY_BASE_URL = normalizeBaseUrl(process.env.COOLIFY_BASE_URL ?? 'https://panel.nemdar.tech');
const COOLIFY_API_TOKEN = process.env.COOLIFY_API_TOKEN;
const MCP_API_KEY = process.env.MCP_API_KEY;
const MCP_PUBLIC_URL = normalizeBaseUrl(process.env.MCP_PUBLIC_URL ?? 'https://coolify-mcp.nemdar.tech');

if (!COOLIFY_API_TOKEN) throw new Error('COOLIFY_API_TOKEN is required');
if (!MCP_API_KEY) throw new Error('MCP_API_KEY is required');

const buildPack = z.enum(['nixpacks', 'static', 'dockerfile', 'dockercompose']);
const optionalText = z.string().min(1).optional();

export function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

export function extractBearer(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1];
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signPayload(payload) {
  const encoded = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', MCP_API_KEY).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyPayload(value, expectedType) {
  const [encoded, suppliedSignature, extra] = (value ?? '').split('.');
  if (!encoded || !suppliedSignature || extra) return null;
  const expectedSignature = createHmac('sha256', MCP_API_KEY).update(encoded).digest();
  let supplied;
  try { supplied = Buffer.from(suppliedSignature, 'base64url'); } catch { return null; }
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.type !== expectedType || !Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function isAllowedRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com'));
  } catch { return false; }
}

function oauthError(c, status, error, description) {
  return c.json({ error, error_description: description }, status);
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export function normalizeDomains(domains) {
  return [...new Set(domains.map((domain) => {
    const url = new URL(domain);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Domains must use http or https');
    url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }))].join(',');
}

async function coolify(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${COOLIFY_BASE_URL}/api/v1${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${COOLIFY_API_TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  });

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }

  if (!response.ok) {
    const message = typeof data?.message === 'string' ? data.message : `Coolify API returned ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

function result(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data
  };
}

function failure(error) {
  const payload = {
    error: error instanceof Error ? error.message : 'Unknown error',
    status: error?.status,
    details: error?.details
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

function buildServer() {
  const server = new McpServer({ name: 'nemdar-coolify-extension', version: '0.1.0' });

  server.registerTool('create_application', {
    title: 'Create Coolify application',
    description: 'Create a team-owned Coolify application from a public Git repository or a private repository connected through a Coolify GitHub App. Does not deploy unless instant_deploy=true.',
    inputSchema: z.object({
      source_type: z.enum(['public', 'private_github_app']),
      project_uuid: z.string().min(1),
      server_uuid: z.string().min(1),
      environment_name: optionalText,
      environment_uuid: optionalText,
      github_app_uuid: optionalText,
      git_repository: z.string().min(1),
      git_branch: z.string().min(1).default('main'),
      build_pack: buildPack,
      ports_exposes: z.string().min(1),
      destination_uuid: optionalText,
      name: optionalText,
      description: optionalText,
      domains: z.array(z.url()).optional(),
      base_directory: optionalText,
      publish_directory: optionalText,
      dockerfile_location: optionalText,
      docker_compose_location: optionalText,
      install_command: optionalText,
      build_command: optionalText,
      start_command: optionalText,
      is_static: z.boolean().optional(),
      is_spa: z.boolean().optional(),
      is_auto_deploy_enabled: z.boolean().optional(),
      is_force_https_enabled: z.boolean().optional(),
      health_check_enabled: z.boolean().optional(),
      health_check_path: optionalText,
      instant_deploy: z.boolean().default(false),
      force_domain_override: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, async (input) => {
    try {
      if (!input.environment_name && !input.environment_uuid) {
        throw new Error('environment_name or environment_uuid is required');
      }
      if (input.source_type === 'private_github_app' && !input.github_app_uuid) {
        throw new Error('github_app_uuid is required for private_github_app');
      }

      const { source_type, domains, ...body } = input;
      if (source_type === 'public') delete body.github_app_uuid;
      if (domains) body.domains = normalizeDomains(domains);
      const endpoint = source_type === 'public' ? '/applications/public' : '/applications/private-github-app';
      return result(await coolify(endpoint, { method: 'POST', body }));
    } catch (error) { return failure(error); }
  });

  server.registerTool('update_application', {
    title: 'Update Coolify application',
    description: 'Update allowlisted configuration fields on an existing Coolify application by UUID. Omitted fields remain unchanged.',
    inputSchema: z.object({
      uuid: z.string().min(1),
      name: optionalText,
      description: z.string().optional(),
      git_branch: optionalText,
      build_pack: buildPack.optional(),
      ports_exposes: optionalText,
      base_directory: z.string().optional(),
      publish_directory: z.string().optional(),
      dockerfile_location: optionalText,
      docker_compose_location: optionalText,
      install_command: z.string().optional(),
      build_command: z.string().optional(),
      start_command: z.string().optional(),
      is_static: z.boolean().optional(),
      is_spa: z.boolean().optional(),
      is_auto_deploy_enabled: z.boolean().optional(),
      is_force_https_enabled: z.boolean().optional(),
      health_check_enabled: z.boolean().optional(),
      health_check_path: z.string().optional(),
      force_domain_override: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ uuid, ...body }) => {
    try {
      const meaningfulKeys = Object.keys(body).filter((key) => key !== 'force_domain_override');
      if (meaningfulKeys.length === 0) throw new Error('At least one update field is required');
      return result(await coolify(`/applications/${encodeURIComponent(uuid)}`, { method: 'PATCH', body }));
    } catch (error) { return failure(error); }
  });

  server.registerTool('set_domain', {
    title: 'Set Coolify application domains',
    description: 'Replace all domains on a Coolify application. Pass the complete desired domain list. Domain conflicts are rejected unless force_domain_override=true.',
    inputSchema: z.object({
      uuid: z.string().min(1),
      domains: z.array(z.url()).min(1),
      force_domain_override: z.boolean().default(false)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ uuid, domains, force_domain_override }) => {
    try {
      const body = { domains: normalizeDomains(domains), force_domain_override };
      return result(await coolify(`/applications/${encodeURIComponent(uuid)}`, { method: 'PATCH', body }));
    } catch (error) { return failure(error); }
  });

  return server;
}

const handler = createMcpHandler(buildServer);
const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok', service: 'nemdar-coolify-extension' }));

const authorizationServerMetadata = {
  issuer: MCP_PUBLIC_URL,
  authorization_endpoint: `${MCP_PUBLIC_URL}/oauth/authorize`,
  token_endpoint: `${MCP_PUBLIC_URL}/oauth/token`,
  registration_endpoint: `${MCP_PUBLIC_URL}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: ['mcp']
};

app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata));
app.get('/.well-known/oauth-protected-resource', (c) => c.json({
  resource: `${MCP_PUBLIC_URL}/mcp`,
  authorization_servers: [MCP_PUBLIC_URL],
  scopes_supported: ['mcp'],
  bearer_methods_supported: ['header']
}));
app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json({
  resource: `${MCP_PUBLIC_URL}/mcp`,
  authorization_servers: [MCP_PUBLIC_URL],
  scopes_supported: ['mcp'],
  bearer_methods_supported: ['header']
}));

app.post('/oauth/register', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return oauthError(c, 400, 'invalid_client_metadata', 'Request body must be JSON'); }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
    return oauthError(c, 400, 'invalid_redirect_uri', 'Only HTTPS chatgpt.com callback URLs are allowed');
  }
  const clientId = signPayload({
    type: 'client',
    redirect_uris: redirectUris,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    nonce: randomBytes(12).toString('base64url')
  });
  return c.json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  }, 201);
});

app.get('/oauth/authorize', (c) => {
  const query = c.req.query();
  const client = verifyPayload(query.client_id, 'client');
  if (!client || !client.redirect_uris.includes(query.redirect_uri) || !isAllowedRedirectUri(query.redirect_uri)) {
    return oauthError(c, 400, 'invalid_request', 'Invalid client or redirect URI');
  }
  if (query.response_type !== 'code' || query.code_challenge_method !== 'S256' || !query.code_challenge) {
    return oauthError(c, 400, 'invalid_request', 'Authorization code flow with PKCE S256 is required');
  }
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map((name) => `<input type="hidden" name="${name}" value="${htmlEscape(query[name] ?? '')}">`).join('');
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NEMDAR Coolify Admin</title><style>body{font:16px system-ui;background:#0b0b0c;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(420px,88vw);padding:28px;border:1px solid #333;border-radius:16px;background:#151517}input,button{box-sizing:border-box;width:100%;padding:13px;margin-top:12px;border-radius:9px;border:1px solid #444;background:#222;color:#fff}button{background:#6d28d9;border:0;font-weight:700;cursor:pointer}small{color:#aaa}</style></head><body><form class="card" method="post" action="/oauth/authorize"><h2>NEMDAR Coolify Admin</h2><p>Authorize ChatGPT to manage NEMDAR Coolify applications.</p>${hidden}<label>Admin access key<input type="password" name="access_key" required autocomplete="current-password"></label><button type="submit">Authorize</button><p><small>Use the MCP_API_KEY configured in Coolify.</small></p></form></body></html>`);
});

app.post('/oauth/authorize', async (c) => {
  const form = await c.req.parseBody();
  const client = verifyPayload(form.client_id, 'client');
  if (!client || !client.redirect_uris.includes(form.redirect_uri) || !isAllowedRedirectUri(form.redirect_uri)) {
    return oauthError(c, 400, 'invalid_request', 'Invalid client or redirect URI');
  }
  const provided = Buffer.from(String(form.access_key ?? ''));
  const expected = Buffer.from(MCP_API_KEY);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return c.html('<h1>Authorization denied</h1><p>The admin access key is incorrect.</p>', 401);
  }
  if (form.code_challenge_method !== 'S256' || !form.code_challenge) {
    return oauthError(c, 400, 'invalid_request', 'PKCE S256 is required');
  }
  const code = signPayload({
    type: 'code', client_id: form.client_id, redirect_uri: form.redirect_uri,
    code_challenge: form.code_challenge, scope: form.scope || 'mcp',
    resource: form.resource || `${MCP_PUBLIC_URL}/mcp`,
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: randomBytes(16).toString('base64url')
  });
  const redirect = new URL(String(form.redirect_uri));
  redirect.searchParams.set('code', code);
  if (form.state) redirect.searchParams.set('state', String(form.state));
  return c.redirect(redirect.toString(), 302);
});

app.post('/oauth/token', async (c) => {
  const form = await c.req.parseBody();
  if (form.grant_type !== 'authorization_code') return oauthError(c, 400, 'unsupported_grant_type', 'Only authorization_code is supported');
  const code = verifyPayload(form.code, 'code');
  if (!code || code.client_id !== form.client_id || code.redirect_uri !== form.redirect_uri) {
    return oauthError(c, 400, 'invalid_grant', 'Invalid or expired authorization code');
  }
  const challenge = createHash('sha256').update(String(form.code_verifier ?? '')).digest('base64url');
  if (!form.code_verifier || challenge !== code.code_challenge) return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed');
  const accessToken = signPayload({
    type: 'access', scope: code.scope || 'mcp', resource: code.resource,
    exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
    nonce: randomBytes(16).toString('base64url')
  });
  return c.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 8 * 60 * 60, scope: code.scope || 'mcp' });
});

app.use('/mcp', async (c, next) => {
  // ChatGPT scans tool definitions before the user completes OAuth. Permit only
  // protocol initialization and schema discovery anonymously; every tool call
  // remains protected by an OAuth access token.
  if (c.req.method === 'POST') {
    try {
      const message = await c.req.raw.clone().json();
      const publicMethods = new Set(['initialize', 'notifications/initialized', 'tools/list', 'ping']);
      if (publicMethods.has(message?.method)) {
        await next();
        return;
      }
    } catch {
      // Let the authenticated path return the appropriate response.
    }
  }
  const provided = extractBearer(c.req.header('authorization'));
  const token = verifyPayload(provided, 'access');
  if (!token) {
    c.header('WWW-Authenticate', `Bearer resource_metadata="${MCP_PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`);
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});
app.all('/mcp', (c) => handler.fetch(c.req.raw));

export function start() {
  return serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
    console.log(`NEMDAR Coolify MCP extension listening on :${PORT}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
