import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { YnabService } from './ynab.js';
import { registerTools } from './tools.js';
import type { AuthProps, Env } from '../worker-configuration.js';

/**
 * The MCP endpoint.
 *
 * OAuthProvider only routes a request here after it has validated the bearer
 * token, so by the time this runs the caller is authenticated and the granted
 * scope is sitting in `ctx.props`.
 *
 * The transport runs stateless: a fresh server is built for every request from
 * the scopes on the presented token. That is what makes scope-gated tools work,
 * and it suits Workers, where there is no long-lived process to hold a session
 * in the first place.
 */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      // Stateless: no server-initiated stream, no session to delete.
      return json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'This server is stateless; use POST.' }, id: null },
        405,
        { Allow: 'POST' },
      );
    }

    // OAuthProvider decrypts the grant's props into ctx.props before routing here.
    const scopes = (ctx.props as AuthProps | undefined)?.scope ?? [];
    const ynab = new YnabService(env);

    const server = new McpServer(
      { name: 'ynab-mcp-server', version: '1.0.0' },
      {
        instructions:
          'Tools for reading and managing a YNAB (You Need A Budget) budget. Amounts are plain currency ' +
          'values, not milliunits. Start with get_month_summary for "how am I doing this month" questions, ' +
          'list_categories for category balances, and list_transactions for spending detail. Ids for accounts ' +
          'and categories come from list_accounts and list_categories.',
      },
    );

    // Writes need both the deployment-level switch and a token that was
    // actually granted the write scope.
    registerTools(server, ynab, ynab.allowWrites && scopes.includes('ynab:write'));

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (err) {
      console.error('[mcp] request failed:', (err as Error).message);
      return json(
        { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
        500,
      );
    }
  },
};

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
