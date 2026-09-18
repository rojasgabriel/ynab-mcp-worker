import OAuthProvider from '@cloudflare/workers-oauth-provider';
import consentHandler, { supportedScopes } from './consent.js';
import mcpHandler from './mcp.js';
import type { Env } from '../worker-configuration.js';

/**
 * ynab-mcp-server on Cloudflare Workers.
 *
 * OAuthProvider is the whole authorization server: dynamic client
 * registration, PKCE, token issuance, refresh and rotation, and both
 * .well-known metadata documents. It stores clients, grants and tokens in the
 * OAUTH_KV namespace, and encrypts the props we attach to a grant.
 *
 * That leaves two pieces of our own:
 *   - consentHandler  (defaultHandler) — the passphrase screen at /authorize
 *   - mcpHandler      (apiHandler)     — the MCP endpoint at /mcp
 *
 * The provider only routes to mcpHandler after validating the bearer token,
 * so nothing unauthenticated ever reaches the YNAB code.
 *
 * The provider is built per request because the advertised scope list depends
 * on whether this deployment allows writes, and that comes from env. It is
 * plain configuration, so the cost is negligible.
 */

function createProvider(env: Env): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpHandler as never,
    defaultHandler: consentHandler as never,

    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',

    scopesSupported: supportedScopes(env),

    accessTokenTTL: 60 * 60,

    // The resource identifier is derived from the request URL, so this works on
    // workers.dev and on a custom domain with no configuration change.
    resourceMetadata: {
      resource_name: env.SERVER_LABEL?.trim() || 'YNAB MCP',
      scopes_supported: supportedScopes(env),
    },
  });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createProvider(env).fetch(request, env, ctx);
  },
};
