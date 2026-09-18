# ynab-mcp-worker

A remote MCP server that gives Claude access to your YNAB budget, running on
Cloudflare Workers and deployable as a claude.ai custom connector. Once
connected it works everywhere you use Claude — web, Desktop, mobile and Cowork —
because the connector lives on your Claude account, not on a machine you have to
keep running.

Free to run on Cloudflare's free tier. No container, no always-on instance, no
monthly bill.

## How it holds together

Your YNAB Personal Access Token lives in one place: Cloudflare's encrypted
secret store. The Worker reads it to make server-to-server calls to
`api.ynab.com`. It is never sent to Claude and never appears in a log line.

Claude authenticates separately, over OAuth. The first time you add the
connector, Claude registers itself, gets sent to a consent screen, and you type
your passphrase. After that Claude holds a short-lived access token and a
rotating refresh token. Anyone who finds your Worker's URL without the
passphrase gets a `401` and nothing else.

```
  Claude  ──OAuth bearer token──>  this Worker  ──YNAB PAT──>  api.ynab.com
                                        │
                                   AUTH_PASSPHRASE
                                 (typed by you, once)
```

Be clear-eyed about what that means: the passphrase is the only thing protecting
your budget, and the Worker can do anything your YNAB token can do. Use a long
random passphrase, and leave `YNAB_ALLOW_WRITES` off until you have watched the
read-only tools behave.

Most of the OAuth machinery is not mine.
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
is the authorization server: dynamic client registration, PKCE, token issuance,
refresh and rotation, and both `.well-known` metadata documents, with clients
and grants stored in a KV namespace and grant props encrypted at rest. This repo
supplies two things on top — the consent screen and the MCP endpoint.

## What Claude can do with it

Six read tools are always available: `list_budgets`, `list_accounts`,
`list_categories`, `get_month_summary`, `list_transactions` and `list_payees`.

Three write tools appear only when `YNAB_ALLOW_WRITES` is `"true"`:
`create_transaction` records a transaction, `set_category_budget` sets a
category's budgeted amount for a month, and `move_money` shifts budgeted money
between two categories — the usual fix for an overspent category.

Amounts crossing the tool boundary are plain currency values like `-42.50`,
never YNAB's internal milliunits, because milliunits are an easy way for a model
to be wrong by a factor of a thousand. Responses are trimmed to the fields that
matter; raw YNAB categories carry about thirty `goal_*` fields each, which would
bury the numbers you asked about.

Writes are gated twice: the deployment-level `YNAB_ALLOW_WRITES` switch, and the
OAuth scope actually granted to the token. A connection authorized for
`ynab:read` alone will not even see the write tools listed.

## Deploying

You need a YNAB Personal Access Token (YNAB → Account Settings → Developer
Settings → New Token) and a free Cloudflare account.

Generate a passphrase first and put it somewhere you will not lose it:

```bash
openssl rand -base64 24
```

Then pick one of three routes. All three end up in the same place.

### Option 1 — one click, no terminal

Push this repo to GitHub (public is fine — there are no secrets in it), then
replace `YOUR-USERNAME/YOUR-REPO` below and click the button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-USERNAME/YOUR-REPO)

Cloudflare clones the repo into your account, **creates the KV namespace and
writes its id into the config for you**, prompts for the two secrets from
`.dev.vars.example`, deploys, and wires up Workers Builds so future pushes
redeploy automatically. It works in a phone browser.

### Option 2 — connect a GitHub repo in the dashboard

If the repo is already on GitHub and you would rather not use a button:

1. Create the KV namespace: Cloudflare dashboard → Storage & Databases → KV →
   Create. Paste the id into `wrangler.jsonc`, commit, push.
2. Workers & Pages → Create application → **Import a repository** → pick it.
3. Once it deploys, open the Worker → Settings → Variables and Secrets, and add
   `YNAB_ACCESS_TOKEN` and `AUTH_PASSPHRASE` as **secrets** (not plaintext
   variables). Redeploy.

Every push to `main` redeploys from then on. Also browser-only.

### Option 3 — the CLI

```bash
npm install
npx wrangler login

# Creates the KV namespace the OAuth provider uses; paste the returned id
# into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV

# Pick a name in wrangler.jsonc — it becomes part of your URL

# Stored encrypted by Cloudflare; never in the repo, never in the bundle
npx wrangler secret put YNAB_ACCESS_TOKEN
npx wrangler secret put AUTH_PASSPHRASE

npx wrangler deploy
```

Wrangler prints your URL, something like
`https://ynab-mcp.your-subdomain.workers.dev`.

### A note on GitHub Actions

`.github/workflows/deploy.yml` is included for deploying from CI instead, which
also runs a typecheck first. It needs one repo secret, `CLOUDFLARE_API_TOKEN`.
If you used Option 1 or 2, Cloudflare already deploys on push and this workflow
is redundant — delete it.

Either way, do not put `YNAB_ACCESS_TOKEN` or `AUTH_PASSPHRASE` into GitHub.
Worker secrets persist across deploys, so CI never needs them, and keeping them
out means one fewer place your YNAB token exists.

### Turning on writes

Set `YNAB_ALLOW_WRITES` to `"true"` in `wrangler.jsonc` and redeploy (push, or
`npx wrangler deploy`). You will also need to disconnect and reconnect the
connector in Claude, because the granted scope is baked into the existing token.

### Running it locally first

```bash
cp .dev.vars.example .dev.vars   # fill in the two secrets
npx wrangler dev
```

`wrangler dev` simulates KV locally, so the placeholder namespace id in
`wrangler.jsonc` is fine for local runs. Claude cannot reach localhost, so this
is for verification only — see the smoke test below.

## Connecting it to Claude

In claude.ai, open Settings → Connectors → Add custom connector, and give it:

```
https://your-worker-url.workers.dev/mcp
```

Note the `/mcp` path. The bare origin will not work: the protected resource
metadata declares the resource identifier as the full URL including the path,
and Claude checks that the two match.

Leave the OAuth Client ID and Secret fields empty — the Worker supports Dynamic
Client Registration, so Claude registers itself. Claude then opens the consent
screen; type your passphrase and approve. That is the whole setup, and it works
from a phone browser if you would rather not use a laptop.

Your Worker needs to be reachable from Anthropic's egress range,
`160.79.104.0/21`. Workers are public by default, so this only matters if you put
Cloudflare Access or a WAF rule in front of it.

## Verifying a deployment

`scripts/smoke-test.mjs` walks the exact path Claude walks — discovery, dynamic
client registration, the consent screen, the PKCE token exchange, an
authenticated MCP session, refresh rotation — and checks that the things that
should be rejected are: unauthenticated calls, forged tokens, wrong passphrases,
mismatched PKCE verifiers, replayed authorization codes and superseded refresh
tokens.

```bash
node scripts/smoke-test.mjs https://your-worker-url.workers.dev 'your-passphrase'
```

It exits non-zero if anything fails. Run it after your first deploy, and again
any time you change the auth configuration.

`scripts/check-behaviors.mjs` is a smaller companion that prints which tools a
given OAuth scope actually exposes — the quickest way to confirm read-only mode
is doing what you think.

## Configuration

Set in `wrangler.jsonc` under `vars`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `YNAB_ALLOW_WRITES` | `"false"` | `"true"` registers the write tools. |
| `YNAB_DEFAULT_BUDGET_ID` | `"last-used"` | Budget used when a tool call omits one. |
| `SERVER_LABEL` | `"YNAB MCP"` | Name shown on the consent screen. |

Set with `wrangler secret put`, never in the repo:

| Secret | Purpose |
| --- | --- |
| `YNAB_ACCESS_TOKEN` | Your YNAB Personal Access Token. |
| `AUTH_PASSPHRASE` | Typed on the consent screen. Make it long and random. |

## What this costs

Nothing, in practice. Cloudflare's Workers free tier covers 100,000 requests a
day and the KV free tier covers 100,000 reads and 1,000 writes a day. A personal
connector makes a handful of requests per conversation, and KV writes only
happen when a client registers or a token rotates. YNAB's own limit of 200
requests per hour per token will bind long before anything of Cloudflare's does.

## Security notes, including one honest caveat

The passphrase is hashed and compared in constant time, so neither its length
nor its content leaks through timing. The consent page ships a strict CSP, sets
`X-Frame-Options: DENY`, and runs no JavaScript at all.

The parsed authorization request is round-tripped through a hidden form field.
That is safe because `completeAuthorization` independently re-validates the
client, the redirect URI against the client's registered URIs, the PKCE
challenge and the resource parameter — a tampered field is rejected rather than
followed.

**The caveat.** Cloudflare's OAuth provider rotates refresh tokens on every use
but deliberately keeps exactly one previous token valid, so that a client whose
rotation response was lost in flight is not permanently locked out. It does not
implement strict reuse detection, which would revoke the whole grant the moment a
superseded token is replayed. This is a mainstream trade-off — Auth0 and Okta
both ship the same grace window — but it is weaker than revoking on replay, and
it is worth knowing rather than assuming. A token from further back than that one
step is refused; the smoke test pins exactly that boundary.

Rotation behaves differently per secret, and one case is a trap. Rotating the
YNAB token is invisible to Claude — set it and redeploy. Rotating
`AUTH_PASSPHRASE` does **not** disconnect existing connections, because they
already hold refresh tokens and never see the consent screen again. If you think
your passphrase leaked, change it *and* revoke the existing grants by clearing
the KV namespace, then reconnect.

## Licence

MIT
