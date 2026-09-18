import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { YnabError, YnabService } from './ynab.js';
import type { ScheduledEditFields, TxnEditFields } from './ynab.js';

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
const CLEARED = ['cleared', 'uncleared', 'reconciled'] as const;
const FREQUENCIES = [
  'never', 'daily', 'weekly', 'everyOtherWeek', 'twiceAMonth', 'every4Weeks', 'monthly',
  'everyOtherMonth', 'every3Months', 'every4Months', 'twiceAYear', 'yearly', 'everyOtherYear',
] as const;

/** Editable transaction fields, shared by update_transaction and the bulk item. */
const txnEditShape = {
  approved: z.boolean().optional().describe('Approve or unapprove the transaction.'),
  category_id: z.string().optional().describe('Assign or change the category. Ids come from list_categories.'),
  amount: z.number().optional().describe('New amount in currency units, negative for spending. E.g. -42.50.'),
  date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe('New transaction date (YYYY-MM-DD).'),
  payee_name: z.string().max(200).optional().describe('New payee name. YNAB creates the payee if it is new.'),
  memo: z.string().max(500).optional().describe('New memo.'),
  cleared: z.enum(CLEARED).optional().describe('Cleared status.'),
  flag_color: z.enum(FLAG_COLORS).optional().describe('Flag color.'),
};

/** Editable scheduled-transaction fields (the API has no cleared/approved here). */
const scheduledEditShape = {
  account_id: z.string().optional().describe('Move it to a different account.'),
  amount: z.number().optional().describe('Amount in currency units, negative for spending. E.g. -15.99.'),
  date: z.string().regex(DATE_RE, 'Use YYYY-MM-DD').optional().describe('Next scheduled date (YYYY-MM-DD), up to 5 years out.'),
  frequency: z.enum(FREQUENCIES).optional().describe('How often it repeats. "never" means a single future transaction.'),
  category_id: z.string().optional().describe('Category id from list_categories.'),
  payee_name: z.string().max(200).optional().describe('Payee name.'),
  memo: z.string().max(500).optional().describe('Memo.'),
  flag_color: z.enum(FLAG_COLORS).optional().describe('Flag color.'),
};

type TxnEditArgs = {
  approved?: boolean;
  category_id?: string;
  amount?: number;
  date?: string;
  payee_name?: string;
  memo?: string;
  cleared?: (typeof CLEARED)[number];
  flag_color?: (typeof FLAG_COLORS)[number];
};

function toTxnFields(a: TxnEditArgs): TxnEditFields {
  return {
    ...(a.approved !== undefined ? { approved: a.approved } : {}),
    ...(a.category_id !== undefined ? { categoryId: a.category_id } : {}),
    ...(a.amount !== undefined ? { amountMilliunits: toMilliunits(a.amount) } : {}),
    ...(a.date !== undefined ? { date: a.date } : {}),
    ...(a.payee_name !== undefined ? { payeeName: a.payee_name } : {}),
    ...(a.memo !== undefined ? { memo: a.memo } : {}),
    ...(a.cleared !== undefined ? { cleared: a.cleared } : {}),
    ...(a.flag_color !== undefined ? { flagColor: a.flag_color } : {}),
  };
}

function toScheduledFields(a: {
  account_id?: string;
  amount?: number;
  date?: string;
  frequency?: (typeof FREQUENCIES)[number];
  category_id?: string;
  payee_name?: string;
  memo?: string;
  flag_color?: (typeof FLAG_COLORS)[number];
}): ScheduledEditFields {
  return {
    ...(a.account_id !== undefined ? { accountId: a.account_id } : {}),
    ...(a.amount !== undefined ? { amountMilliunits: toMilliunits(a.amount) } : {}),
    ...(a.date !== undefined ? { date: a.date } : {}),
    ...(a.frequency !== undefined ? { frequency: a.frequency } : {}),
    ...(a.category_id !== undefined ? { categoryId: a.category_id } : {}),
    ...(a.payee_name !== undefined ? { payeeName: a.payee_name } : {}),
    ...(a.memo !== undefined ? { memo: a.memo } : {}),
    ...(a.flag_color !== undefined ? { flagColor: a.flag_color } : {}),
  };
}

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

  server.registerTool(
    'list_scheduled_transactions',
    {
      title: 'List scheduled transactions',
      description:
        'List scheduled (recurring or future-dated) transactions, with their next date, frequency and amount. ' +
        'Use this to find recurring charges — e.g. a duplicated subscription showing up as two schedules.',
      inputSchema: {
        budget_id: budgetIdSchema,
        account_id: z.string().optional().describe('Restrict to one account.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id, account_id }) =>
      run(() => ynab.listScheduledTransactions(ynab.budgetId(budget_id), account_id)),
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

  server.registerTool(
    'update_transaction',
    {
      title: 'Update transaction',
      description:
        'Edit an existing transaction. Use this to approve a pending transaction (approved: true), categorize an ' +
        'uncategorized one (category_id), fix a wrong amount or payee, set cleared status, add a memo, or flag it. ' +
        'Only the fields you pass are changed; everything else is left as-is. Get the id from list_transactions.',
      inputSchema: {
        budget_id: budgetIdSchema,
        transaction_id: z.string().describe('The transaction to edit. Get this from list_transactions.'),
        ...txnEditShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id, transaction_id, ...fields }) =>
      run(() => ynab.updateTransaction(ynab.budgetId(budget_id), transaction_id, toTxnFields(fields))),
  );

  server.registerTool(
    'bulk_update_transactions',
    {
      title: 'Update many transactions',
      description:
        'Edit several transactions in one request — the efficient way to approve or categorize a batch. Each entry ' +
        'needs a transaction_id plus the fields to change on it. Done in a single API call to avoid rate limits.',
      inputSchema: {
        budget_id: budgetIdSchema,
        updates: z
          .array(z.object({ transaction_id: z.string(), ...txnEditShape }))
          .min(1)
          .max(200)
          .describe('One entry per transaction: its id and the fields to change.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id, updates }) =>
      run(() =>
        ynab.bulkUpdateTransactions(
          ynab.budgetId(budget_id),
          updates.map((u) => ({ transactionId: u.transaction_id, ...toTxnFields(u) })),
        ),
      ),
  );

  server.registerTool(
    'delete_transaction',
    {
      title: 'Delete transaction',
      description:
        'Permanently delete a transaction. Useful for removing a duplicate charge. This cannot be undone through ' +
        'the API — get the id from list_transactions and be sure it is the right one.',
      inputSchema: {
        budget_id: budgetIdSchema,
        transaction_id: z.string().describe('The transaction to delete. Get this from list_transactions.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ budget_id, transaction_id }) =>
      run(() => ynab.deleteTransaction(ynab.budgetId(budget_id), transaction_id)),
  );

  server.registerTool(
    'create_scheduled_transaction',
    {
      title: 'Create scheduled transaction',
      description:
        'Schedule a recurring or future-dated transaction. Amount is in plain currency (negative for spending).',
      inputSchema: {
        budget_id: budgetIdSchema,
        account_id: z.string().describe('Account it belongs to. Get this from list_accounts.'),
        date: z
          .string()
          .regex(DATE_RE, 'Use YYYY-MM-DD')
          .describe('First/next scheduled date (YYYY-MM-DD), up to 5 years out.'),
        frequency: z.enum(FREQUENCIES).describe('How often it repeats. "never" means a single future transaction.'),
        amount: z.number().describe('Amount in currency units, negative for spending. E.g. -15.99.'),
        category_id: z.string().optional().describe('Category id from list_categories.'),
        payee_name: z.string().max(200).optional().describe('Payee name.'),
        memo: z.string().max(500).optional().describe('Optional memo.'),
        flag_color: z.enum(FLAG_COLORS).optional().describe('Flag color.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ budget_id, account_id, date, ...rest }) =>
      run(() =>
        ynab.createScheduledTransaction(ynab.budgetId(budget_id), {
          accountId: account_id,
          date,
          ...toScheduledFields(rest),
        }),
      ),
  );

  server.registerTool(
    'update_scheduled_transaction',
    {
      title: 'Update scheduled transaction',
      description:
        'Edit a scheduled transaction — change its amount, next date, frequency, category, payee or memo. Only the ' +
        'fields you pass change. Get the id from list_scheduled_transactions.',
      inputSchema: {
        budget_id: budgetIdSchema,
        scheduled_transaction_id: z.string().describe('The scheduled transaction to edit.'),
        ...scheduledEditShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id, scheduled_transaction_id, ...fields }) =>
      run(() =>
        ynab.updateScheduledTransaction(
          ynab.budgetId(budget_id),
          scheduled_transaction_id,
          toScheduledFields(fields),
        ),
      ),
  );

  server.registerTool(
    'delete_scheduled_transaction',
    {
      title: 'Delete scheduled transaction',
      description:
        'Permanently delete a scheduled transaction — the fix for a duplicate recurring charge. Cannot be undone ' +
        'through the API. Get the id from list_scheduled_transactions.',
      inputSchema: {
        budget_id: budgetIdSchema,
        scheduled_transaction_id: z.string().describe('The scheduled transaction to delete.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ budget_id, scheduled_transaction_id }) =>
      run(() => ynab.deleteScheduledTransaction(ynab.budgetId(budget_id), scheduled_transaction_id)),
  );

  server.registerTool(
    'update_category',
    {
      title: 'Rename or annotate category',
      description:
        'Rename a category or set its note. To change how much is budgeted to a category, use set_category_budget ' +
        'or move_money instead. (The YNAB API cannot create or delete categories, only edit existing ones.)',
      inputSchema: {
        budget_id: budgetIdSchema,
        category_id: z.string().describe('The category to edit. Get this from list_categories.'),
        name: z.string().max(100).optional().describe('New category name.'),
        note: z.string().max(500).optional().describe('New note (pass an empty string to clear it).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id, category_id, name, note }) =>
      run(() =>
        ynab.updateCategory(ynab.budgetId(budget_id), category_id, {
          ...(name !== undefined ? { name } : {}),
          ...(note !== undefined ? { note } : {}),
        }),
      ),
  );

  server.registerTool(
    'update_payee',
    {
      title: 'Rename payee',
      description:
        'Rename a payee. Renaming to an existing payee’s exact name is how YNAB effectively merges them. (The ' +
        'API exposes renaming only, not a dedicated merge, and cannot delete payees.)',
      inputSchema: {
        budget_id: budgetIdSchema,
        payee_id: z.string().describe('The payee to rename. Get this from list_payees.'),
        name: z.string().min(1).max(500).describe('New payee name.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id, payee_id, name }) =>
      run(() => ynab.updatePayee(ynab.budgetId(budget_id), payee_id, name)),
  );
}
