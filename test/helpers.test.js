import test from 'node:test';
import assert from 'node:assert/strict';

process.env.COOLIFY_API_TOKEN = 'test-token';
process.env.MCP_API_KEY = 'test-mcp-key';
process.env.PORT = '0';

const { extractBearer, normalizeBaseUrl, normalizeDomains } = await import('../src/server.js');

test('normalizes the Coolify base URL', () => {
  assert.equal(normalizeBaseUrl('https://panel.nemdar.tech/api/v1/'), 'https://panel.nemdar.tech');
});

test('extracts a bearer token', () => {
  assert.equal(extractBearer('Bearer secret'), 'secret');
  assert.equal(extractBearer('Basic secret'), undefined);
});

test('normalizes and deduplicates domains', () => {
  assert.equal(
    normalizeDomains(['https://example.com/', 'https://example.com', 'http://www.example.com/']),
    'https://example.com,http://www.example.com'
  );
});
