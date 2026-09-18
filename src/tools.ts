import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { YnabError, YnabService } from './ynab.js';

/**
 * MCP tool surface.
 *
 * Design notes:
 *   - Amounts crossing the tool boundary are plain decimal currency
 *     ("-42.50"), never milliunits. Milliunits are an internal YNAB detail and
 *     an easy way for a model to be off by a factor of a thousand.
 *   - Write tools are only registered when YNAB_ALLOW_WRITES is on, so a
 *     read-only deployment does not merely refuse writes, it never advertises
 *     them in the first place.
 */

const MONTH_DESCRIPTION =
  'Budget month. Accepts "current", "YYYY-MM", or "YYYY-MM-DD". Defaults to the current month.';

/** "current" | "2026-03" | "2026-03-14" -> "2026-03-01" */
export function normalizeMonth(input?: string): string {
  const value = (input ?? 'current').trim().toLowerCase();

  if (value === 'current' || value === 'this month' || value === '') {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) {
    throw new YnabError(`"${input}" is not a valid month. Use "current", "YYYY-MM", or "YYYY-MM-DD".`);
  }
  return `${match[1]}-${match[2]}-01`;
}

/** 42.5 -> 42500 milliunits */
function toMilliunits(amount: number): number {
  return Math.round(amount * 1000);
}

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const budgetIdSchema = z
  .string()
  .optional()
  .describe('Budget (plan) id. Omit to use the server default, which is normally your last-used budget.');

export function registerTools(server: McpServer, ynab: YnabService, allowWrites: boolean): void {
  // ------------------------------------------------------------------ reads

  server.registerTool(
    'list_budgets',
    {
      title: 'List budgets',
      description:
        'List the YNAB budgets (plans) this token can see, with their ids, currency and last-modified date. ' +
        'Use this first if you need a budget id for the other tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => ynab.listBudgets()),
  );

  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'List accounts in a budget with their current, cleared and uncleared balances. ' +
        'Closed accounts are excluded unless you ask for them.',
      inputSchema: {
        budget_id: budgetIdSchema,
        include_closed: z.boolean().optional().describe('Include closed accounts. Defaults to false.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id, include_closed }) =>
      run(() => ynab.listAccounts(ynab.budgetId(budget_id), include_closed ?? false)),
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description:
        'List budget categories grouped by category group, with the amount budgeted, the activity and the ' +
        'remaining balance for the current month, plus goal progress where a goal is set.',
      inputSchema: {
        budget_id: budgetIdSchema,
        include_hidden: z.boolean().optional().describe('Include hidden categories. Defaults to false.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id, include_hidden }) =>
      run(() => ynab.listCategories(ynab.budgetId(budget_id), include_hidden ?? false)),
  );

  server.registerTool(
    'get_month_summary',
    {
      title: 'Get month summary',
      description:
        'Overview of one budget month: income, total budgeted, activity, the amount still to be budgeted, ' +
        'age of money, and the lists of overspent and underfunded categories. This is the best starting point ' +
        'for questions like "how is this month going?" or "what still needs funding?".',
      inputSchema: {
        budget_id: budgetIdSchema,
        month: z.string().optional().describe(MONTH_DESCRIPTION),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id, month }) =>
      run(() => ynab.getMonth(ynab.budgetId(budget_id), normalizeMonth(month))),
  );

  server.registerTool(
    'list_transactions',
    {
      title: 'List transactions',
      description:
        'List transactions, most recent first. Filter by date, account, or category, and optionally show only ' +
        'uncategorized or unapproved transactions. Results are capped to keep responses small — narrow the ' +
        'filters rather than raising the limit when you can.',
      inputSchema: {
        budget_id: budgetIdSchema,
        since_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .optional()
          .describe('Only transactions on or after this date (YYYY-MM-DD).'),
        account_id: z.string().optional().describe('Restrict to one account.'),
        category_id: z.string().optional().describe('Restrict to one category. Ignored if account_id is set.'),
        type: z
          .enum(['uncategorized', 'unapproved'])
          .optional()
          .describe('Show only uncategorized or only unapproved transactions.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum rows to return. Default 50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id, since_date, account_id, category_id, type, limit }) =>
      run(() =>
        ynab.listTransactions(ynab.budgetId(budget_id), {
          ...(since_date ? { sinceDate: since_date } : {}),
          ...(account_id ? { accountId: account_id } : {}),
          ...(category_id ? { categoryId: category_id } : {}),
          ...(type ? { type } : {}),
          limit: limit ?? 50,
        }),
      ),
  );

  server.registerTool(
    'list_payees',
    {
      title: 'List payees',
      description:
        'List payees in a budget. Useful for resolving a payee name to an id, or for checking how a payee is ' +
        'spelled before creating a transaction.',
      inputSchema: { budget_id: budgetIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id }) => run(() => ynab.listPayees(ynab.budgetId(budget_id))),
  );

  if (!allowWrites) return;

  // ----------------------------------------------------------------- writes

  server.registerTool(
    'create_transaction',
    {
      title: 'Create transaction',
      description:
        'Record a new transaction. Amounts are in plain currency: negative for money leaving the account ' +
        '(a purchase), positive for money arriving (income, a refund). For example -42.50 for a $42.50 expense.',
      inputSchema: {
        budget_id: budgetIdSchema,
        account_id: z.string().describe('Account the transaction belongs to. Get this from list_accounts.'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .describe('Transaction date (YYYY-MM-DD).'),
        amount: z
          .number()
          .describe('Amount in currency units. Negative for spending, positive for income. E.g. -42.50.'),
        payee_name: z.string().max(200).optional().describe('Payee name. YNAB creates the payee if it is new.'),
        category_id: z.string().optional().describe('Category to assign. Omit to leave uncategorized.'),
        memo: z.string().max(500).optional().describe('Optional memo.'),
        cleared: z
          .enum(['cleared', 'uncleared', 'reconciled'])
          .optional()
          .describe('Cleared status. Defaults to uncleared.'),
        approved: z.boolean().optional().describe('Whether the transaction is approved. Defaults to true.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(() =>
        ynab.createTransaction(ynab.budgetId(args.budget_id), {
          accountId: args.account_id,
          date: args.date,
          amount: toMilliunits(args.amount),
          ...(args.payee_name ? { payeeName: args.payee_name } : {}),
          ...(args.category_id ? { categoryId: args.category_id } : {}),
          ...(args.memo ? { memo: args.memo } : {}),
          ...(args.cleared ? { cleared: args.cleared } : {}),
          ...(args.approved !== undefined ? { approved: args.approved } : {}),
        }),
      ),
  );

  server.registerTool(
    'set_category_budget',
    {
      title: 'Set category budget',
      description:
        'Set the amount budgeted to a category for a month. This replaces the budgeted amount rather than ' +
        'adding to it — read the current value with list_categories or get_month_summary first if you mean ' +
        'to adjust it. To shift money between two categories, prefer move_money.',
      inputSchema: {
        budget_id: budgetIdSchema,
        category_id: z.string().describe('Category to fund. Get this from list_categories.'),
        month: z.string().optional().describe(MONTH_DESCRIPTION),
        budgeted: z
          .number()
          .describe('New budgeted amount in currency units, e.g. 250 for $250.00. Replaces the existing amount.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id, category_id, month, budgeted }) =>
      run(() =>
        ynab.updateBudgetedAmount(
          ynab.budgetId(budget_id),
          normalizeMonth(month),
          category_id,
          toMilliunits(budgeted),
        ),
      ),
  );

  server.registerTool(
    'move_money',
    {
      title: 'Move money between categories',
      description:
        'Move budgeted money from one category to another within a month — the usual fix for an overspent ' +
        'category. Reads both categories first and reports the before and after amounts. Not atomic: if the ' +
        'second write fails the first is rolled back, and the error says exactly what happened.',
      inputSchema: {
        budget_id: budgetIdSchema,
        from_category_id: z.string().describe('Category to take money from.'),
        to_category_id: z.string().describe('Category to give money to.'),
        amount: z.number().positive().describe('Amount to move in currency units, e.g. 75.00. Must be positive.'),
        month: z.string().optional().describe(MONTH_DESCRIPTION),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ budget_id, from_category_id, to_category_id, amount, month }) =>
      run(() =>
        ynab.moveMoney(
          ynab.budgetId(budget_id),
          normalizeMonth(month),
          from_category_id,
          to_category_id,
          toMilliunits(amount),
        ),
      ),
  );
}
