# YNAB MCP worker

A remote [MCP](https://modelcontextprotocol.io) server for [YNAB](https://www.ynab.com). It runs on Cloudflare Workers and connects to Claude as a [custom connector](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp). Once connected, it works in Claude on the web, desktop, and mobile.

It runs on Cloudflare’s free tier. There is no container and no monthly host to keep online.

This repository is a live deployment. If you [fork it](#fork-and-deploy), change the worker name and KV namespace before you deploy.

## How it works

```
Claude  --OAuth-->  this Worker  --YNAB personal access token-->  api.ynab.com
                         |
                   AUTH_PASSPHRASE
                 (typed once, on consent)
```

- Your YNAB personal access token stays in Cloudflare’s encrypted secret store. The Worker uses it for server-to-server calls. Claude never sees it.
- Claude authenticates with OAuth. The first connection shows a consent screen; you type a passphrase. After that, Claude uses short-lived access tokens and rotating refresh tokens.
- The passphrase is the only thing that protects the Worker URL. Use a long random value. Anyone who finds the URL and the passphrase can do whatever your YNAB token can do.

OAuth (registration, PKCE, tokens, refresh) comes from [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). This repo adds the consent screen and the MCP tools.

## Tools

Amounts in tool arguments and responses are ordinary currency (`-42.50`), not YNAB milliunits.

**Always available**

| Tool | Purpose |
| --- | --- |
| `list_budgets` | Budgets the token can see |
| `list_accounts` | Accounts and balances |
| `list_categories` | Category groups and categories |
| `get_month_summary` | One month’s budget, activity, and balance |
| `list_transactions` | Transactions, with optional filters |
| `list_payees` | Payees |
| `list_scheduled_transactions` | Upcoming scheduled transactions |
| `list_months` | Months that have budget data |
| `get_budget_settings` | Currency and date format |
| `get_user` | Authenticated YNAB user id |

**When `YNAB_ALLOW_WRITES` is `"true"`**

Transactions: `create_transaction`, `update_transaction`, `bulk_update_transactions`, `delete_transaction`, `import_transactions`  
Scheduled: `create_scheduled_transaction`, `update_scheduled_transaction`, `delete_scheduled_transaction`  
Budget: `set_category_budget`, `move_money`, `update_category`, `create_category`, `create_category_group`, `update_category_group`  
Accounts and payees: `create_account`, `update_payee`, `merge_payees`

Writes are gated twice: the Worker flag, and the OAuth scope on the Claude connection (`ynab:read` vs `ynab:write`). A read-only connection does not list write tools.

## Fork and deploy

You need a [YNAB personal access token](https://app.ynab.com/settings/developer) and a free Cloudflare account.

**If you forked this repo**, do these first:

1. Change `"name"` in `wrangler.jsonc`. That name becomes your `*.workers.dev` URL.
2. Create your own KV namespace (`npx wrangler kv namespace create OAUTH_KV`) and paste the id into `wrangler.jsonc`. Do not reuse the id already in this file.
3. Keep `"YNAB_ALLOW_WRITES": "false"` until you have watched the read tools against your own budget.

Generate a passphrase and store it somewhere safe:

```bash
openssl rand -base64 24
```

### CLI

```bash
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV   # paste the id into wrangler.jsonc
npx wrangler secret put YNAB_ACCESS_TOKEN
npx wrangler secret put AUTH_PASSPHRASE
npx wrangler deploy
```

Wrangler prints a URL such as `https://ynab-mcp-worker.your-subdomain.workers.dev`.

### One-click (Cloudflare dashboard)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rojasgabriel/ynab-mcp-worker)

After a fork, change the button URL to your fork. Cloudflare creates the KV namespace, asks for the two secrets, and deploys.

### GitHub Actions

`.github/workflows/deploy.yml` typechecks, tests, and deploys on push to `main`. Add one repo secret: `CLOUDFLARE_API_TOKEN`. Do not put `YNAB_ACCESS_TOKEN` or `AUTH_PASSPHRASE` in GitHub. Set those on the Worker; they persist across deploys.

If you already deploy with Workers Builds, this workflow is redundant. Delete it.

### Writes

Set `YNAB_ALLOW_WRITES` to `"true"` in `wrangler.jsonc` and redeploy. Then disconnect and reconnect the connector in Claude, because the granted scope lives on the existing token.

## Connect in Claude

Settings → Connectors → Add custom connector:

```
https://your-worker-url.workers.dev/mcp
```

The `/mcp` path is required. Leave the OAuth client id and secret empty; Claude registers itself. Type your passphrase on the consent screen.

The Worker must be reachable from Anthropic’s egress range `160.79.104.0/21`. Workers are public by default, so this only matters if you put Cloudflare Access or a WAF in front of it.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the two secrets
npx wrangler dev
```

Local KV is simulated, so the committed namespace id is fine here. Claude cannot reach localhost.

Against a deployed Worker:

```bash
node scripts/smoke-test.mjs https://your-worker-url.workers.dev 'your-passphrase'
node scripts/check-behaviors.mjs https://your-worker-url.workers.dev 'your-passphrase'
```

`npm test` checks transfer handling, payee merge, and advertised tool schemas. It does not need a live Worker.

## Configuration

Set in `wrangler.jsonc` under `vars`:

| Variable | Default in this repo | Purpose |
| --- | --- | --- |
| `YNAB_ALLOW_WRITES` | `"true"` on this deployment | `"true"` registers write tools. Forks should start with `"false"`. |
| `YNAB_DEFAULT_BUDGET_ID` | `"last-used"` | Budget used when a tool omits one. |
| `SERVER_LABEL` | `"YNAB MCP"` | Name on the consent screen. |

Set with `npx wrangler secret put`, never in the repo:

| Secret | Purpose |
| --- | --- |
| `YNAB_ACCESS_TOKEN` | YNAB personal access token |
| `AUTH_PASSPHRASE` | Consent-screen passphrase |

## Security

- The passphrase is hashed and compared in constant time. The consent page has a strict CSP, `X-Frame-Options: DENY`, and no JavaScript.
- Rotating `YNAB_ACCESS_TOKEN` is invisible to Claude. Rotating `AUTH_PASSPHRASE` does **not** drop existing connections. If the passphrase leaked, change it and clear the `OAUTH_KV` namespace, then reconnect.
- Cloudflare’s OAuth provider keeps the previous refresh token valid for one rotation, so a lost in-flight response does not lock Claude out. A token older than that one step is rejected.

## License

MIT
