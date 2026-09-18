#!/usr/bin/env node
/**
 * End-to-end check of a running ynab-mcp-server.
 *
 * It walks the exact path Claude walks when you add the connector: discovery,
 * dynamic client registration, the consent screen, the PKCE token exchange,
 * an authenticated MCP session, and a refresh. It also checks that the things
 * that should be rejected actually are.
 *
 * Usage:
 *   node scripts/smoke-test.mjs <base-url> <passphrase>
 *
 * Example:
 *   node scripts/smoke-test.mjs https://ynab-mcp.fly.dev 'my-long-passphrase'
 *
 * Exits non-zero if any check fails.
 */

import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.argv[2] ?? 'http://localhost:8080').replace(/\/+$/, '');
const PASSPHRASE = process.argv[3] ?? process.env.AUTH_PASSPHRASE;

if (!PASSPHRASE) {
  console.error('Usage: node scripts/smoke-test.mjs <base-url> <passphrase>');
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const b64url = (buf) => buf.toString('base64url');

// --------------------------------------------------------------- discovery

section('1. Discovery');

const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
const prmBody = prm.ok ? await prm.json() : {};
check('protected resource metadata is served', prm.ok, `HTTP ${prm.status}`);
check(
  'resource identifier matches the connector URL',
  prmBody.resource === `${BASE}/mcp`,
  `got ${prmBody.resource}`,
);
check(
  'advertises an authorization server',
  Array.isArray(prmBody.authorization_servers) && prmBody.authorization_servers.length > 0,
);

const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
const asmBody = asm.ok ? await asm.json() : {};
check('authorization server metadata is served', asm.ok, `HTTP ${asm.status}`);
check(
  'advertises S256 PKCE (Claude requires this)',
  asmBody.code_challenge_methods_supported?.includes('S256'),
  JSON.stringify(asmBody.code_challenge_methods_supported),
);
check('advertises a registration endpoint (DCR)', Boolean(asmBody.registration_endpoint));
check(
  'advertises offline_access so refresh tokens are issued',
  asmBody.scopes_supported?.includes('offline_access'),
  JSON.stringify(asmBody.scopes_supported),
);

// ------------------------------------------------------------ unauthorized

section('2. Unauthenticated access is refused');

const unauth = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
check('POST /mcp without a token returns 401', unauth.status === 401, `HTTP ${unauth.status}`);
const wwwAuth = unauth.headers.get('www-authenticate') ?? '';
check('401 carries a WWW-Authenticate header', wwwAuth.toLowerCase().startsWith('bearer'), wwwAuth);
check(
  'WWW-Authenticate points at the resource metadata',
  wwwAuth.includes('resource_metadata='),
  wwwAuth,
);

const badToken = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer not-a-real-token',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
check('a forged bearer token is rejected', badToken.status === 401, `HTTP ${badToken.status}`);

// ----------------------------------------------------------- registration

section('3. Dynamic client registration');

const registration = await fetch(`${BASE}/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'smoke-test',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }),
});
const client = registration.ok ? await registration.json() : {};
check('client registration succeeds', registration.ok, `HTTP ${registration.status}`);
check('a client_id was issued', Boolean(client.client_id));

// --------------------------------------------------------------- authorize

section('4. Authorization and consent');

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(12));

const authorizeUrl = new URL(`${BASE}/authorize`);
authorizeUrl.searchParams.set('client_id', client.client_id ?? '');
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('redirect_uri', 'https://claude.ai/api/mcp/auth_callback');
authorizeUrl.searchParams.set('code_challenge', challenge);
authorizeUrl.searchParams.set('code_challenge_method', 'S256');
authorizeUrl.searchParams.set('state', state);
authorizeUrl.searchParams.set('scope', 'ynab:read ynab:write offline_access');
authorizeUrl.searchParams.set('resource', `${BASE}/mcp`);

const consentPage = await fetch(authorizeUrl, { redirect: 'manual' });
const consentHtml = await consentPage.text();
check('consent screen renders', consentPage.status === 200, `HTTP ${consentPage.status}`);
check('consent screen asks for a passphrase', consentHtml.includes('name="passphrase"'));

const requestToken = /name="request" value="([^"]+)"/.exec(consentHtml)?.[1];
check('consent screen carries a signed request token', Boolean(requestToken));

// Read the form's action rather than assuming a path, so this script works
// against any build of the server.
const consentAction = new URL(
  /<form[^>]*action="([^"]+)"/.exec(consentHtml)?.[1] ?? '/consent',
  BASE,
).href;

// Wrong passphrase first.
const wrongConsent = await fetch(consentAction, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ request: requestToken ?? '', passphrase: 'definitely-wrong' }),
  redirect: 'manual',
});
check('wrong passphrase is rejected', wrongConsent.status === 401, `HTTP ${wrongConsent.status}`);

// Correct passphrase.
const consent = await fetch(consentAction, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ request: requestToken ?? '', passphrase: PASSPHRASE }),
  redirect: 'manual',
});
check('correct passphrase redirects back to the client', consent.status === 302, `HTTP ${consent.status}`);

const redirectLocation = new URL(consent.headers.get('location') ?? 'https://example.invalid');
const code = redirectLocation.searchParams.get('code');
check('an authorization code was issued', Boolean(code));
check('state is echoed back unchanged', redirectLocation.searchParams.get('state') === state);

// ------------------------------------------------------------------ tokens

section('5. Token exchange');

async function exchange(params) {
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const wrongVerifier = await exchange({
  grant_type: 'authorization_code',
  code: code ?? '',
  client_id: client.client_id ?? '',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_verifier: b64url(randomBytes(32)),
  resource: `${BASE}/mcp`,
});
check('a mismatched PKCE verifier is rejected', wrongVerifier.status >= 400, `HTTP ${wrongVerifier.status}`);

const tokens = await exchange({
  grant_type: 'authorization_code',
  code: code ?? '',
  client_id: client.client_id ?? '',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_verifier: verifier,
  resource: `${BASE}/mcp`,
});
check('authorization code exchanges for tokens', tokens.status === 200, JSON.stringify(tokens.body));
check('an access token was issued', Boolean(tokens.body.access_token));
check('a refresh token was issued', Boolean(tokens.body.refresh_token));

// The single-use check lives in section 8, not here: replaying a code also
// revokes the client's tokens (OAuth 2.1 says it should), which would pull the
// rug out from under the MCP and refresh checks below.

// --------------------------------------------------------------------- MCP

section('6. Authenticated MCP session');

async function mcp(accessToken, body) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  // Streamable HTTP may answer as SSE; pull the JSON out of the data: line.
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '{}')
    : JSON.parse(text || '{}');

  return { status: res.status, payload };
}

const init = await mcp(tokens.body.access_token, {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  },
});
check('initialize succeeds', init.status === 200 && Boolean(init.payload.result), JSON.stringify(init.payload));
check(
  'server identifies itself',
  init.payload.result?.serverInfo?.name === 'ynab-mcp-server',
  JSON.stringify(init.payload.result?.serverInfo),
);

const list = await mcp(tokens.body.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
const toolNames = (list.payload.result?.tools ?? []).map((t) => t.name);
check('tools/list succeeds', list.status === 200 && Array.isArray(list.payload.result?.tools));
check('read tools are present', toolNames.includes('get_month_summary'), toolNames.join(', '));
console.log(`        tools: ${toolNames.join(', ') || '(none)'}`);

// ------------------------------------------------------------------ refresh

section('7. Refresh token rotation');

const refreshed = await exchange({
  grant_type: 'refresh_token',
  refresh_token: tokens.body.refresh_token ?? '',
  client_id: client.client_id ?? '',
  resource: `${BASE}/mcp`,
});
check('refresh token exchanges for a new access token', refreshed.status === 200, JSON.stringify(refreshed.body));
check('a rotated refresh token is returned', Boolean(refreshed.body.refresh_token));
check(
  'the rotated refresh token is different',
  refreshed.body.refresh_token !== tokens.body.refresh_token,
);

// The OAuth provider keeps exactly ONE previous refresh token valid, so that a
// client whose rotation response was lost in flight is not locked out. That is
// a deliberate grace window, not a gap — what must not work is a token from two
// rotations back.
const oneBack = await exchange({
  grant_type: 'refresh_token',
  refresh_token: tokens.body.refresh_token ?? '',
  client_id: client.client_id ?? '',
  resource: `${BASE}/mcp`,
});
check(
  'the immediately-previous refresh token still works (retry grace window)',
  oneBack.status === 200,
  `HTTP ${oneBack.status}`,
);

// That retry rotated again, which pushes the token issued in between out of the
// window. It must now be refused — the window holds one token, not a history.
const superseded = await exchange({
  grant_type: 'refresh_token',
  refresh_token: refreshed.body.refresh_token ?? '',
  client_id: client.client_id ?? '',
  resource: `${BASE}/mcp`,
});
check(
  'a superseded refresh token outside the window is rejected',
  superseded.status >= 400,
  `HTTP ${superseded.status}`,
);

// --------------------------------------------------------- replay defences

section('8. Authorization code replay');

const replay = await exchange({
  grant_type: 'authorization_code',
  code: code ?? '',
  client_id: client.client_id ?? '',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_verifier: verifier,
  resource: `${BASE}/mcp`,
});
check('the authorization code is single-use', replay.status >= 400, `HTTP ${replay.status}`);

// ------------------------------------------------------------------ result

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
