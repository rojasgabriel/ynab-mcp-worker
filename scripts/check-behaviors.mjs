#!/usr/bin/env node
/**
 * Supplementary checks that the main smoke test does not cover:
 *   - a tool call surfaces a readable YNAB error rather than a raw stack trace
 *   - a token granted only ynab:read never sees the write tools
 *
 * Usage: node scripts/check-behaviors.mjs <base-url> <passphrase> [scope-string]
 */

import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.argv[2] ?? 'http://localhost:8080').replace(/\/+$/, '');
const PASSPHRASE = process.argv[3];
const SCOPE = process.argv[4] ?? 'ynab:read ynab:write offline_access';

const b64url = (b) => b.toString('base64url');

async function connect() {
  const reg = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'behaviour-check',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  }).then((r) => r.json());

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  const url = new URL(`${BASE}/authorize`);
  url.searchParams.set('client_id', reg.client_id);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', SCOPE);

  const html = await fetch(url, { redirect: 'manual' }).then((r) => r.text());
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1];

  // The consent form posts back to whatever action the page declares.
  const action = new URL(/<form[^>]*action="([^"]+)"/.exec(html)?.[1] ?? '/consent', BASE).href;

  const consent = await fetch(action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request, passphrase: PASSPHRASE }),
    redirect: 'manual',
  });
  const code = new URL(consent.headers.get('location')).searchParams.get('code');

  const tokens = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: reg.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: verifier,
    }),
  }).then((r) => r.json());

  return tokens.access_token;
}

async function rpc(token, body) {
  const text = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }).then((r) => r.text());

  return text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5).trim())
    : JSON.parse(text);
}

const token = await connect();
console.log(`granted scope: ${SCOPE}`);

const tools = (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map(
  (t) => t.name,
);
console.log(`tools visible: ${tools.join(', ')}`);

const writeTools = [
  'create_transaction', 'set_category_budget', 'move_money',
  'update_transaction', 'bulk_update_transactions', 'delete_transaction',
  'create_scheduled_transaction', 'update_scheduled_transaction', 'delete_scheduled_transaction',
  'update_category', 'update_payee',
];
const visibleWrites = writeTools.filter((t) => tools.includes(t));
console.log(`write tools visible: ${visibleWrites.length ? visibleWrites.join(', ') : '(none)'}`);

// list_scheduled_transactions is a read — it must always be present.
if (!tools.includes('list_scheduled_transactions')) {
  throw new Error('assertion failed: list_scheduled_transactions is missing from the read tools');
}
// When the granted scope includes ynab:write, every write tool must be registered.
if (SCOPE.includes('ynab:write')) {
  const missing = writeTools.filter((t) => !tools.includes(t));
  if (missing.length) throw new Error(`assertion failed: write scope granted but tools missing: ${missing.join(', ')}`);
  console.log('assertion ok: all write tools present under ynab:write');
} else if (visibleWrites.length) {
  throw new Error(`assertion failed: no write scope but write tools visible: ${visibleWrites.join(', ')}`);
}

const call = await rpc(token, {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'list_budgets', arguments: {} },
});
console.log(`\nlist_budgets result (expected: a readable YNAB auth error, since the test token is fake):`);
console.log(`  isError: ${call.result?.isError}`);
console.log(`  text:    ${call.result?.content?.[0]?.text}`);
