/**
 * Bindings available to the Worker.
 *
 * `vars` come from wrangler.jsonc and are plain configuration.
 * The two secrets are set with `wrangler secret put` and are stored encrypted
 * by Cloudflare — they are never in the repo and never in the bundle.
 */
export interface Env {
  /** Storage for OAuth clients, grants and tokens. Managed by OAuthProvider. */
  OAUTH_KV: KVNamespace;

  /** Secret: your YNAB Personal Access Token. */
  YNAB_ACCESS_TOKEN: string;

  /** Secret: the passphrase typed on the consent screen. */
  AUTH_PASSPHRASE: string;

  /** Var: "true" to register the write tools. */
  YNAB_ALLOW_WRITES?: string;

  /** Var: budget used when a tool call omits one. */
  YNAB_DEFAULT_BUDGET_ID?: string;

  /** Var: name shown on the consent screen. */
  SERVER_LABEL?: string;
}

/**
 * What we store in the OAuth grant's `props`, which the provider encrypts into
 * the access token and hands back to the API handler as `ctx.props`.
 */
export interface AuthProps {
  scope: string[];
}
