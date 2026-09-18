import type { AuthRequest, ClientInfo, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from '../worker-configuration.js';

/**
 * The consent screen — the only human-facing part of this Worker.
 *
 * OAuthProvider handles registration, PKCE, tokens and refresh; the one thing
 * it cannot decide is whether the person at the keyboard is you. That is what
 * AUTH_PASSPHRASE is for, and it is the only thing standing between the public
 * internet and your budget.
 *
 * The parsed authorization request is round-tripped through a hidden form
 * field. That is safe because completeAuthorization re-validates the redirect
 * URI against the client's registered URIs, so a tampered field is rejected
 * rather than followed.
 */

interface EnvWithOAuth extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

export default {
  async fetch(request: Request, env: EnvWithOAuth): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/authorize') {
      return request.method === 'POST'
        ? handleConsentSubmit(request, env)
        : handleAuthorize(request, env);
    }

    if (url.pathname === '/healthz') {
      return Response.json({
        status: 'ok',
        mode: env.YNAB_ALLOW_WRITES === 'true' ? 'read-write' : 'read-only',
        resource: new URL('/mcp', url.origin).href,
      });
    }

    if (url.pathname === '/') return landingPage(env, url.origin);

    return new Response('Not found', { status: 404 });
  },
};

// ---------------------------------------------------------------- handlers

async function handleAuthorize(request: Request, env: EnvWithOAuth): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return htmlResponse(
      errorPage(label(env), 'That authorization request is not valid.', (err as Error).message),
      400,
    );
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) {
    return htmlResponse(
      errorPage(label(env), 'Unknown client.', 'This client is not registered with this server.'),
      400,
    );
  }

  return htmlResponse(
    consentPage({
      serverLabel: label(env),
      client,
      authRequest,
      scopes: negotiateScopes(authRequest.scope, env),
      allowWrites: env.YNAB_ALLOW_WRITES === 'true',
    }),
  );
}

async function handleConsentSubmit(request: Request, env: EnvWithOAuth): Promise<Response> {
  const form = await request.formData();
  const encoded = String(form.get('request') ?? '');
  const passphrase = String(form.get('passphrase') ?? '');

  let authRequest: AuthRequest;
  try {
    authRequest = decodeAuthRequest(encoded);
  } catch {
    return htmlResponse(
      errorPage(label(env), 'That request expired.', 'Go back to the client and start connecting again.'),
      400,
    );
  }

  if (!(await passphraseMatches(passphrase, env.AUTH_PASSPHRASE))) {
    console.warn('[oauth] consent denied: incorrect passphrase');
    const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
    return htmlResponse(
      consentPage({
        serverLabel: label(env),
        client,
        authRequest,
        scopes: negotiateScopes(authRequest.scope, env),
        allowWrites: env.YNAB_ALLOW_WRITES === 'true',
        error: 'That passphrase is not correct.',
      }),
      401,
    );
  }

  const scope = negotiateScopes(authRequest.scope, env);

  try {
    // completeAuthorization re-validates the client, redirect URI, PKCE and
    // resource, so a tampered hidden field fails here rather than redirecting.
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: 'owner',
      metadata: { grantedAt: new Date().toISOString() },
      scope,
      props: { scope },
    });

    console.log(`[oauth] consent granted to client ${authRequest.clientId}`);
    return Response.redirect(redirectTo, 302);
  } catch (err) {
    console.error('[oauth] completeAuthorization failed:', (err as Error).message);
    return htmlResponse(
      errorPage(label(env), 'Could not complete authorization.', (err as Error).message),
      400,
    );
  }
}

// ----------------------------------------------------------------- helpers

function label(env: Env): string {
  return env.SERVER_LABEL?.trim() || 'YNAB MCP';
}

function negotiateScopes(requested: string[] | undefined, env: Env): string[] {
  const supported = new Set(supportedScopes(env));
  const wanted = requested && requested.length > 0 ? requested : supportedScopes(env);
  const granted = wanted.filter((s) => supported.has(s));

  // A connection with no scopes at all is useless; always grant read.
  if (!granted.includes('ynab:read')) granted.unshift('ynab:read');
  return [...new Set(granted)];
}

export function supportedScopes(env: Env): string[] {
  return env.YNAB_ALLOW_WRITES === 'true'
    ? ['ynab:read', 'ynab:write', 'offline_access']
    : ['ynab:read', 'offline_access'];
}

function encodeAuthRequest(authRequest: AuthRequest): string {
  return btoa(JSON.stringify(authRequest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeAuthRequest(encoded: string): AuthRequest {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const parsed = JSON.parse(atob(padded)) as AuthRequest;
  if (!parsed.clientId || !parsed.redirectUri) throw new Error('incomplete authorization request');
  return parsed;
}

/**
 * Constant-time passphrase check.
 *
 * Both sides are hashed first so the comparison is over fixed-length buffers —
 * that way neither the length nor the content of the attempt leaks through
 * timing.
 */
async function passphraseMatches(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(a, b);

  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  let diff = viewA.length ^ viewB.length;
  for (let i = 0; i < viewA.length; i++) diff |= (viewA[i] ?? 0) ^ (viewB[i] ?? 0);
  return diff === 0;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// -------------------------------------------------------------------- HTML

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'ynab:read': 'Read your budgets, accounts, categories and transactions',
  'ynab:write': 'Create and modify transactions and budgeted amounts',
  offline_access: 'Stay connected without re-entering this passphrase',
};

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px;
    font: 16px/1.55 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f4f4f5; color: #18181b;
  }
  main {
    width: 100%; max-width: 440px; background: #fff; border: 1px solid #e4e4e7;
    border-radius: 14px; padding: 28px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.06);
  }
  h1 { margin: 0 0 6px; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 20px; color: #52525b; font-size: 14px; }
  ul { margin: 0 0 20px; padding: 0; list-style: none;
       border: 1px solid #e4e4e7; border-radius: 10px; overflow: hidden; }
  li { padding: 11px 14px; font-size: 14px; border-bottom: 1px solid #f4f4f5; }
  li:last-child { border-bottom: 0; }
  li b { font-weight: 600; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 7px; }
  input {
    width: 100%; padding: 10px 12px; font-size: 15px; font-family: inherit;
    border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; color: inherit;
  }
  input:focus { outline: 2px solid #2563eb; outline-offset: -1px; border-color: #2563eb; }
  button {
    width: 100%; margin-top: 16px; padding: 11px; font-size: 15px; font-weight: 600;
    font-family: inherit; color: #fff; background: #18181b; border: 0; border-radius: 8px;
    cursor: pointer;
  }
  button:hover { background: #27272a; }
  .err {
    margin: 0 0 16px; padding: 10px 12px; font-size: 14px; border-radius: 8px;
    background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;
  }
  .foot { margin: 18px 0 0; font-size: 12px; color: #71717a; }
  code { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .ro { display: inline-block; margin-bottom: 16px; padding: 3px 9px; font-size: 12px;
        font-weight: 600; border-radius: 999px; background: #f0fdf4; color: #166534;
        border: 1px solid #bbf7d0; }
  @media (prefers-color-scheme: dark) {
    body { background: #09090b; color: #fafafa; }
    main { background: #18181b; border-color: #27272a; }
    p.sub, .foot { color: #a1a1aa; }
    ul { border-color: #27272a; } li { border-bottom-color: #27272a; }
    input { background: #09090b; border-color: #3f3f46; }
    button { background: #fafafa; color: #18181b; }
    button:hover { background: #e4e4e7; }
    .err { background: #450a0a; border-color: #7f1d1d; color: #fecaca; }
    code { background: #27272a; }
    .ro { background: #052e16; border-color: #166534; color: #86efac; }
  }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function consentPage(options: {
  serverLabel: string;
  client: ClientInfo | null;
  authRequest: AuthRequest;
  scopes: string[];
  allowWrites: boolean;
  error?: string;
}): string {
  const clientName = options.client?.clientName
    ? escapeHtml(options.client.clientName)
    : 'An MCP client';

  const scopeList = options.scopes
    .map(
      (scope) =>
        `<li><b>${escapeHtml(scope)}</b><br>${escapeHtml(SCOPE_DESCRIPTIONS[scope] ?? scope)}</li>`,
    )
    .join('');

  let redirectNote = '';
  try {
    redirectNote = `<p class="foot">After approving, you will be sent to
      <code>${escapeHtml(new URL(options.authRequest.redirectUri).origin)}</code>.
      If you did not start this, close this page and change your passphrase.</p>`;
  } catch {
    /* malformed redirect URI is caught by completeAuthorization anyway */
  }

  return page(
    `${options.serverLabel} — authorize`,
    `<h1>Connect to ${escapeHtml(options.serverLabel)}</h1>
     <p class="sub">${clientName} is asking for access to your YNAB budget.</p>
     ${options.allowWrites ? '' : '<span class="ro">Read-only server</span>'}
     ${options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : ''}
     ${scopeList ? `<ul>${scopeList}</ul>` : ''}
     <form method="post" action="/authorize" autocomplete="off">
       <input type="hidden" name="request" value="${escapeHtml(encodeAuthRequest(options.authRequest))}">
       <label for="passphrase">Passphrase</label>
       <input id="passphrase" name="passphrase" type="password" required autofocus
              autocomplete="current-password" placeholder="Your AUTH_PASSPHRASE">
       <button type="submit">Approve access</button>
     </form>
     ${redirectNote}`,
  );
}

function errorPage(serverLabel: string, heading: string, detail: string): string {
  return page(
    `${serverLabel} — error`,
    `<h1>${escapeHtml(heading)}</h1><p class="sub">${escapeHtml(detail)}</p>`,
  );
}

function landingPage(env: Env, origin: string): Response {
  return htmlResponse(
    page(
      label(env),
      `<h1>${escapeHtml(label(env))}</h1>
       <p class="sub">This is a private MCP server. Add it to Claude as a custom connector
       using this URL:</p>
       <p><code>${escapeHtml(new URL('/mcp', origin).href)}</code></p>
       <p class="foot">Connecting requires the passphrase set on this server.</p>`,
    ),
  );
}
