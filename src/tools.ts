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

const transferAccountSchema = z
  .string()
  .optional()
  .describe(
    'Make this a transfer to this account (id from list_accounts) instead of a payee purchase. Do not combine with ' +
      'payee_name. YNAB creates the opposite-sign counterpart on that account automatically.',
  );

const TRANSFER_AMOUNT_AND_CATEGORY =
  'the amount is from the source’s side, negative when money leaves it (e.g. -500 moves $500 out of the source into ' +
  'the destination). Between two budget accounts a transfer has no category — omit category_id. From a budget ' +
  'account to a tracking (off-budget) account such as a loan, category_id is required (the category that pays that ' +
  'account). Enter a transfer before the bank imports arrive and both imported sides will match it.';

/** For tools that take account_id: it is the transfer's source. */
const TRANSFER_RULES =
  ' Transfers: set account_id to the source and transfer_account_id to the destination; ' + TRANSFER_AMOUNT_AND_CATEGORY;

/** For update_transaction, which has no account_id: the source is the account the transaction is already on. */
const TRANSFER_RULES_EXISTING =
  ' Transfers: the source is the account the transaction is already on; set transfer_account_id to the ' +
  'destination; ' + TRANSFER_AMOUNT_AND_CATEGORY;
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
  transfer_account_id: transferAccountSchema,
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
  transfer_account_id: transferAccountSchema,
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
  transfer_account_id?: string;
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
    ...(a.transfer_account_id !== undefined ? { transferAccountId: a.transfer_account_id } : {}),
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
  transfer_account_id?: string;
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
    ...(a.transfer_account_id !== undefined ? { transferAccountId: a.transfer_account_id } : {}),
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
        'Closed accounts are excluded unless you ask for them. Each account’s id is what transfer_account_id takes ' +
        'when recording a transfer to it.',
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
        'filters rather than raising the limit when you can. Transfers carry transfer_account, transfer_account_id ' +
        'and transfer_transaction_id (the linked counterpart on the other account).',
      inputSchema: {
        budget_id: budgetIdSchema,
        since_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .optional()
          .describe('Only transactions on or after this date (YYYY-MM-DD).'),
        account_id: z.string().optional().describe('Restrict to one account.'),
        category_id: z.string().optional().describe('Restrict to one category. Ignored if account_id is set.'),
        payee_id: z
          .string()
          .optional()
          .describe('Restrict to one payee. Ignored if account_id or category_id is set.'),
        type: z
          .enum(['uncategorized', 'unapproved'])
          .optional()
          .describe('Show only uncategorized or only unapproved transactions.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum rows to return. Default 50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id, since_date, account_id, category_id, payee_id, type, limit }) =>
      run(() =>
        ynab.listTransactions(ynab.budgetId(budget_id), {
          ...(since_date ? { sinceDate: since_date } : {}),
          ...(account_id ? { accountId: account_id } : {}),
          ...(category_id ? { categoryId: category_id } : {}),
          ...(payee_id ? { payeeId: payee_id } : {}),
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
        'spelled before creating a transaction. Budgets with long histories have thousands of payees — pass query ' +
        'to narrow the list.',
      inputSchema: {
        budget_id: budgetIdSchema,
        query: z.string().optional().describe('Only payees whose name contains this text (case-insensitive).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id, query }) => run(() => ynab.listPayees(ynab.budgetId(budget_id), query)),
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

  server.registerTool(
    'list_months',
    {
      title: 'List budget months',
      description:
        'List each budget month with its income, total budgeted, activity, and amount left to assign. Use this ' +
        'for trends over time; use get_month_summary for the detail of a single month.',
      inputSchema: { budget_id: budgetIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id }) => run(() => ynab.listMonths(ynab.budgetId(budget_id))),
  );

  server.registerTool(
    'get_budget_settings',
    {
      title: 'Get budget settings',
      description: 'Get a budget’s currency and date-format settings.',
      inputSchema: { budget_id: budgetIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ budget_id }) => run(() => ynab.getBudgetSettings(ynab.budgetId(budget_id))),
  );

  server.registerTool(
    'get_user',
    {
      title: 'Get user',
      description: 'Return the authenticated YNAB user id. Rarely needed; mostly a connectivity check.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => ynab.getUser()),
  );

  if (!allowWrites) return;

  // ----------------------------------------------------------------- writes

  server.registerTool(
    'create_transaction',
    {
      title: 'Create transaction',
      description:
        'Record a new transaction. Amounts are in plain currency: negative for money leaving the account ' +
        '(a purchase), positive for money arriving (income, a refund). For example -42.50 for a $42.50 expense.' +
        TRANSFER_RULES,
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
        transfer_account_id: transferAccountSchema,
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
          ...(args.transfer_account_id ? { transferAccountId: args.transfer_account_id } : {}),
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
        'Only the fields you pass are changed; everything else is left as-is. Get the id from list_transactions. ' +
        'Setting transfer_account_id converts it into a transfer, and YNAB then creates the counterpart on the other ' +
        'account — if that side was already imported, check list_transactions first, or delete the duplicate after.' +
        TRANSFER_RULES_EXISTING,
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
        'needs a transaction_id plus the fields to change on it. Done in a single API call to avoid rate limits. ' +
        'Entries may set transfer_account_id, with the same rules as update_transaction.',
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
        'the API — get the id from list_transactions and be sure it is the right one. Deleting either side of a ' +
        'transfer deletes both sides.',
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
        'Schedule a recurring or future-dated transaction. Amount is in plain currency (negative for spending).' +
        TRANSFER_RULES,
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
        transfer_account_id: transferAccountSchema,
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
        'fields you pass change. Get the id from list_scheduled_transactions.' + TRANSFER_RULES,
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
      title: 'Edit category',
      description:
        'Edit an existing category: rename it, set its note, move it to another category group, or set a monthly ' +
        'goal target. To change the amount assigned for a month, use set_category_budget or move_money instead. ' +
        '(The API cannot delete categories.)',
      inputSchema: {
        budget_id: budgetIdSchema,
        category_id: z.string().describe('The category to edit. Get this from list_categories.'),
        name: z.string().max(100).optional().describe('New category name.'),
        note: z.string().max(500).optional().describe('New note (pass an empty string to clear it).'),
        category_group_id: z.string().optional().describe('Move the category into this group. Get ids from list_categories.'),
        goal_target: z
          .number()
          .optional()
          .describe('Monthly goal target in currency units, e.g. 300 for $300. Creates a monthly goal if none exists.'),
        goal_target_date: z
          .string()
          .regex(DATE_RE, 'Use YYYY-MM-DD')
          .optional()
          .describe('Target date for goals that have a deadline (YYYY-MM-DD).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id, category_id, name, note, category_group_id, goal_target, goal_target_date }) =>
      run(() =>
        ynab.updateCategory(ynab.budgetId(budget_id), category_id, {
          ...(name !== undefined ? { name } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(category_group_id !== undefined ? { categoryGroupId: category_group_id } : {}),
          ...(goal_target !== undefined ? { goalTargetMilliunits: toMilliunits(goal_target) } : {}),
          ...(goal_target_date !== undefined ? { goalTargetDate: goal_target_date } : {}),
        }),
      ),
  );

  server.registerTool(
    'create_category',
    {
      title: 'Create category',
      description:
        'Create a new category inside an existing category group. Get the group id from list_categories (the ' +
        'group_id field). To fund it, follow up with set_category_budget.',
      inputSchema: {
        budget_id: budgetIdSchema,
        name: z.string().min(1).max(100).describe('Name of the new category.'),
        category_group_id: z.string().describe('The group to create it in. Get this from list_categories.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ budget_id, name, category_group_id }) =>
      run(() => ynab.createCategory(ynab.budgetId(budget_id), name, category_group_id)),
  );

  server.registerTool(
    'create_category_group',
    {
      title: 'Create category group',
      description: 'Create a new category group. Add categories to it with create_category.',
      inputSchema: {
        budget_id: budgetIdSchema,
        name: z.string().min(1).max(50).describe('Name of the new category group.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ budget_id, name }) => run(() => ynab.createCategoryGroup(ynab.budgetId(budget_id), name)),
  );

  server.registerTool(
    'update_category_group',
    {
      title: 'Rename category group',
      description: 'Rename an existing category group. Get the id from list_categories (group_id).',
      inputSchema: {
        budget_id: budgetIdSchema,
        category_group_id: z.string().describe('The group to rename.'),
        name: z.string().min(1).max(50).describe('New group name.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id, category_group_id, name }) =>
      run(() => ynab.updateCategoryGroup(ynab.budgetId(budget_id), category_group_id, name)),
  );

  server.registerTool(
    'create_account',
    {
      title: 'Create account',
      description:
        'Create a new account with a starting balance (plain currency; negative for a credit-card or loan balance ' +
        'owed). Note: the API cannot edit or close accounts afterward — that has to be done in YNAB directly.',
      inputSchema: {
        budget_id: budgetIdSchema,
        name: z.string().min(1).max(100).describe('Account name.'),
        type: z
          .enum(['checking', 'savings', 'cash', 'creditCard', 'otherAsset', 'otherLiability'])
          .describe('Account type.'),
        balance: z
          .number()
          .optional()
          .describe('Starting balance in currency units. Negative for money owed. Defaults to 0.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ budget_id, name, type, balance }) =>
      run(() => ynab.createAccount(ynab.budgetId(budget_id), name, type, toMilliunits(balance ?? 0))),
  );

  server.registerTool(
    'import_transactions',
    {
      title: 'Import linked transactions',
      description:
        'Trigger an import of new transactions on all linked (Direct Import) accounts — the same as tapping ' +
        '“Import” in YNAB. Returns the ids of any newly imported transactions. Does nothing for accounts ' +
        'that are not bank-linked.',
      inputSchema: { budget_id: budgetIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id }) => run(() => ynab.importTransactions(ynab.budgetId(budget_id))),
  );

  server.registerTool(
    'update_payee',
    {
      title: 'Rename payee',
      description:
        'Rename a payee. This only changes the name: renaming one payee to another’s name does not merge them ' +
        'through the API, it leaves two payees with the same name. To combine duplicates, use merge_payees.',
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

  server.registerTool(
    'merge_payees',
    {
      title: 'Merge payees',
      description:
        'Combine duplicate payees: every transaction and scheduled transaction on the source payees is moved to ' +
        'the payee named target_name. If no payee has that exact name yet, one of the sources is renamed to it. ' +
        'Venmo-style names such as `Caro Thurin "korean bbq"` lose their note when merged, so with note_to_memo ' +
        '(the default) the note is copied into each transaction’s memo — appended after any existing memo text. ' +
        'Several merges can go in one call; the whole batch costs a handful of API requests, not one per payee. ' +
        'Run with dry_run first to see the counts. The API cannot delete payees, so the emptied ones stay behind ' +
        'for the user to delete in YNAB. Lines inside split transactions are not moved and are reported as skipped.',
      inputSchema: {
        budget_id: budgetIdSchema,
        merges: z
          .array(
            z.object({
              target_name: z.string().min(1).max(200).describe('Name the merged payee should have.'),
              source_payee_ids: z
                .array(z.string())
                .min(1)
                .max(150)
                .describe('Payee ids (from list_payees) to fold into the target.'),
            }),
          )
          .min(1)
          .max(40)
          .describe('One entry per merged payee.'),
        note_to_memo: z
          .boolean()
          .optional()
          .describe('Copy a quoted note in a source payee’s name into its transactions’ memos. Defaults to true.'),
        dry_run: z.boolean().optional().describe('Report what would change without writing anything.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ budget_id, merges, note_to_memo, dry_run }) =>
      run(() =>
        ynab.mergePayees(
          ynab.budgetId(budget_id),
          merges.map((m) => ({ targetName: m.target_name, sourcePayeeIds: m.source_payee_ids })),
          { noteToMemo: note_to_memo ?? true, dryRun: dry_run ?? false },
        ),
      ),
  );
}
