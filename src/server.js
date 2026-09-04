import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const COOLIFY_BASE_URL = normalizeBaseUrl(process.env.COOLIFY_BASE_URL ?? 'https://panel.nemdar.tech');
const COOLIFY_API_TOKEN = process.env.COOLIFY_API_TOKEN;
const MCP_API_KEY = process.env.MCP_API_KEY;

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
app.use('/mcp', async (c, next) => {
  const provided = extractBearer(c.req.header('authorization'));
  if (!provided || provided !== MCP_API_KEY) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});
app.all('/mcp', (c) => handler.fetch(c.req.raw));

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`NEMDAR Coolify MCP extension listening on :${PORT}`);
});
