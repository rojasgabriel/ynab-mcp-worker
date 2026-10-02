import type { Env } from '../worker-configuration.js';

/**
 * A small direct client for the YNAB API.
 *
 * The official `ynab` npm package is generated code that pulls in a fetch
 * ponyfill and Node assumptions; on Workers, where `fetch` is already the
 * platform primitive, hand-writing the dozen calls we need is both smaller and
 * less fragile than bundling it.
 *
 * Two jobs beyond plain API access:
 *   1. Turn milliunits into human-readable money. An LLM reading
 *      "amount: -43210" will sooner or later report that you spent $43,210 on
 *      groceries.
 *   2. Shrink responses. Raw YNAB categories carry about thirty goal_* fields
 *      each; sending all of that for 60 categories buries the numbers you asked
 *      about.
 *
 * Note the paths are /plans/... — YNAB renamed budgets to plans, and that is
 * what the current API serves.
 */

const API_BASE = 'https://api.ynab.com/v1';

export class YnabError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'YnabError';
    this.status = status;
  }
}

export interface CurrencyFormat {
  iso_code: string;
  decimal_digits: number;
  decimal_separator: string;
  group_separator: string;
  symbol_first: boolean;
  currency_symbol: string;
}

const DEFAULT_CURRENCY: CurrencyFormat = {
  iso_code: 'USD',
  decimal_digits: 2,
  decimal_separator: '.',
  group_separator: ',',
  symbol_first: true,
  currency_symbol: '$',
};

// --- the slices of the YNAB schema this server actually reads ---------------

interface Plan {
  id: string;
  name: string;
  last_modified_on?: string;
  first_month?: string;
  last_month?: string;
  currency_format?: CurrencyFormat;
  accounts?: Account[];
}

interface Account {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  deleted: boolean;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
  last_reconciled_at?: string;
  transfer_payee_id?: string | null;
}

interface Category {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
  budgeted: number;
  activity: number;
  balance: number;
  goal_type?: string | null;
  goal_target?: number;
  goal_target_month?: string;
  goal_percentage_complete?: number;
  goal_under_funded?: number;
}

interface CategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
  categories: Category[];
}

interface MonthDetail {
  month: string;
  note?: string;
  income: number;
  budgeted: number;
  activity: number;
  to_be_budgeted: number;
  age_of_money?: number;
  categories: Category[];
}

interface MonthSummaryRow {
  month: string;
  note?: string | null;
  income: number;
  budgeted: number;
  activity: number;
  to_be_budgeted: number;
  age_of_money?: number | null;
  deleted: boolean;
}

interface PlanSettings {
  date_format?: { format: string } | null;
  currency_format?: CurrencyFormat | null;
}

interface TransactionDetail {
  id: string;
  date: string;
  amount: number;
  memo?: string | null;
  cleared: string;
  approved: boolean;
  deleted: boolean;
  account_id: string;
  account_name: string;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
  subtransactions?: Array<{ id: string; payee_id?: string | null; deleted?: boolean }>;
}

interface Payee {
  id: string;
  name: string;
  deleted: boolean;
  transfer_account_id?: string | null;
}

interface ScheduledTransactionDetail {
  id: string;
  date_first: string;
  date_next: string;
  frequency: string;
  amount: number;
  memo?: string | null;
  flag_color?: string | null;
  account_id: string;
  account_name: string;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  transfer_account_id?: string | null;
  deleted: boolean;
  subtransactions?: Array<{ id: string; deleted?: boolean }>;
}

export type FlagColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export type ClearedStatus = 'cleared' | 'uncleared' | 'reconciled';

/** The editable fields shared by update_transaction and bulk_update_transactions. */
export interface TxnEditFields {
  approved?: boolean;
  categoryId?: string;
  amountMilliunits?: number;
  date?: string;
  payeeName?: string;
  memo?: string;
  cleared?: ClearedStatus;
  flagColor?: FlagColor;
  transferAccountId?: string;
}

/** Editable fields for scheduled transactions (no cleared/approved on the API). */
export interface ScheduledEditFields {
  accountId?: string;
  amountMilliunits?: number;
  date?: string;
  frequency?: string;
  categoryId?: string;
  payeeName?: string;
  memo?: string;
  flagColor?: FlagColor;
  transferAccountId?: string;
}

// ---------------------------------------------------------------------------

/**
 * YNAB's /plans transaction endpoints return only a recent window when since_date
 * is omitted, so any read meant to cover a payee's or the budget's whole history
 * has to pass an explicit early date.
 */
export const FULL_HISTORY_SINCE = '2000-01-01';

export class YnabService {
  readonly #token: string;
  readonly #allowWrites: boolean;
  readonly #defaultBudget: string;
  #currencyCache = new Map<string, CurrencyFormat>();

  constructor(env: Env) {
    this.#token = env.YNAB_ACCESS_TOKEN;
    this.#allowWrites = env.YNAB_ALLOW_WRITES === 'true';
    this.#defaultBudget = env.YNAB_DEFAULT_BUDGET_ID?.trim() || 'last-used';
  }

  get allowWrites(): boolean {
    return this.#allowWrites;
  }

  budgetId(explicit?: string): string {
    return explicit?.trim() || this.#defaultBudget;
  }

  // ------------------------------------------------------------ formatting

  /** Milliunits -> "$1,234.56" using the budget's own currency settings. */
  money(milliunits: number, format: CurrencyFormat = DEFAULT_CURRENCY): string {
    const negative = milliunits < 0;
    const fixed = (Math.abs(milliunits) / 1000).toFixed(format.decimal_digits);
    const [whole = '0', fraction] = fixed.split('.');

    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, format.group_separator);
    const body = fraction ? `${grouped}${format.decimal_separator}${fraction}` : grouped;
    const withSymbol = format.symbol_first
      ? `${format.currency_symbol}${body}`
      : `${body}${format.currency_symbol}`;

    return negative ? `-${withSymbol}` : withSymbol;
  }

  async currencyFor(budgetId: string): Promise<CurrencyFormat> {
    const cached = this.#currencyCache.get(budgetId);
    if (cached) return cached;

    try {
      const data = await this.#get<{ plans: Plan[]; default_plan?: Plan }>('/plans');
      const isAlias = budgetId === 'last-used' || budgetId === 'default';
      const match =
        data.plans.find((p) => p.id === budgetId) ??
        (isAlias ? (data.default_plan ?? data.plans[0]) : undefined);
      const format = match?.currency_format ?? DEFAULT_CURRENCY;
      this.#currencyCache.set(budgetId, format);
      return format;
    } catch {
      return DEFAULT_CURRENCY;
    }
  }

  // ----------------------------------------------------------------- reads

  async listBudgets(): Promise<unknown> {
    const data = await this.#get<{ plans: Plan[]; default_plan?: Plan }>('/plans', {
      include_accounts: 'true',
    });

    return data.plans.map((p) => ({
      id: p.id,
      name: p.name,
      is_default: p.id === data.default_plan?.id,
      last_modified_on: p.last_modified_on,
      first_month: p.first_month,
      last_month: p.last_month,
      currency: p.currency_format?.iso_code ?? 'USD',
      accounts: p.accounts?.filter((a) => !a.closed && !a.deleted).length,
    }));
  }

  async listAccounts(budgetId: string, includeClosed: boolean): Promise<unknown> {
    const [currency, data] = await Promise.all([
      this.currencyFor(budgetId),
      this.#get<{ accounts: Account[] }>(`/plans/${enc(budgetId)}/accounts`),
    ]);

    return data.accounts
      .filter((a) => !a.deleted && (includeClosed || !a.closed))
      .map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        on_budget: a.on_budget,
        closed: a.closed,
        balance: this.money(a.balance, currency),
        cleared_balance: this.money(a.cleared_balance, currency),
        uncleared_balance: this.money(a.uncleared_balance, currency),
        balance_milliunits: a.balance,
        last_reconciled_at: a.last_reconciled_at,
        transfer_payee_id: a.transfer_payee_id ?? undefined,
      }));
  }

  async listCategories(budgetId: string, includeHidden: boolean): Promise<unknown> {
    const [currency, data] = await Promise.all([
      this.currencyFor(budgetId),
      this.#get<{ category_groups: CategoryGroup[] }>(`/plans/${enc(budgetId)}/categories`),
    ]);

    return data.category_groups
      .filter((g) => !g.deleted && (includeHidden || !g.hidden))
      .map((group) => ({
        group: group.name,
        group_id: group.id,
        categories: group.categories
          .filter((c) => !c.deleted && (includeHidden || !c.hidden))
          .map((c) => ({
            id: c.id,
            name: c.name,
            budgeted: this.money(c.budgeted, currency),
            activity: this.money(c.activity, currency),
            balance: this.money(c.balance, currency),
            balance_milliunits: c.balance,
            ...(c.goal_type
              ? {
                  goal: {
                    type: c.goal_type,
                    target: c.goal_target != null ? this.money(c.goal_target, currency) : undefined,
                    target_month: c.goal_target_month,
                    percent_complete: c.goal_percentage_complete,
                    under_funded:
                      c.goal_under_funded != null
                        ? this.money(c.goal_under_funded, currency)
                        : undefined,
                  },
                }
              : {}),
          })),
      }));
  }

  async getMonth(budgetId: string, month: string): Promise<unknown> {
    const [currency, data] = await Promise.all([
      this.currencyFor(budgetId),
      this.#get<{ month: MonthDetail }>(`/plans/${enc(budgetId)}/months/${enc(month)}`),
    ]);

    const m = data.month;
    const live = m.categories.filter((c) => !c.deleted && !c.hidden);

    return {
      month: m.month,
      income: this.money(m.income, currency),
      budgeted: this.money(m.budgeted, currency),
      activity: this.money(m.activity, currency),
      to_be_budgeted: this.money(m.to_be_budgeted, currency),
      to_be_budgeted_milliunits: m.to_be_budgeted,
      age_of_money: m.age_of_money,
      category_count: live.length,
      overspent_categories: live
        .filter((c) => c.balance < 0)
        .map((c) => ({ name: c.name, id: c.id, balance: this.money(c.balance, currency) })),
      underfunded_categories: live
        .filter((c) => (c.goal_under_funded ?? 0) > 0)
        .map((c) => ({
          name: c.name,
          id: c.id,
          under_funded: this.money(c.goal_under_funded ?? 0, currency),
        })),
      note: m.note,
    };
  }

  async listTransactions(
    budgetId: string,
    options: {
      sinceDate?: string;
      accountId?: string;
      categoryId?: string;
      payeeId?: string;
      type?: 'uncategorized' | 'unapproved';
      limit: number;
    },
  ): Promise<unknown> {
    const base = `/plans/${enc(budgetId)}`;
    const path = options.accountId
      ? `${base}/accounts/${enc(options.accountId)}/transactions`
      : options.categoryId
        ? `${base}/categories/${enc(options.categoryId)}/transactions`
        : options.payeeId
          ? `${base}/payees/${enc(options.payeeId)}/transactions`
          : `${base}/transactions`;

    const query: Record<string, string> = {};
    query.since_date = options.sinceDate ?? FULL_HISTORY_SINCE;
    if (options.type) query.type = options.type;

    const [currency, data] = await Promise.all([
      this.currencyFor(budgetId),
      this.#get<{ transactions: TransactionDetail[] }>(path, query),
    ]);

    const live = data.transactions.filter((t) => !t.deleted);
    const rows = [...live].sort((a, b) => b.date.localeCompare(a.date)).slice(0, options.limit);

    return {
      returned: rows.length,
      total_matching: live.length,
      transactions: rows.map((t) => ({ ...this.#formatTxn(t, currency), amount_milliunits: t.amount })),
    };
  }

  async listPayees(budgetId: string, query?: string): Promise<unknown> {
    const data = await this.#get<{ payees: Payee[] }>(`/plans/${enc(budgetId)}/payees`);
    const q = query?.trim().toLowerCase();
    return data.payees
      .filter((p) => !p.deleted && (!q || p.name.toLowerCase().includes(q)))
      .map((p) => ({ id: p.id, name: p.name, transfer_account_id: p.transfer_account_id }));
  }

  /**
   * Merge payees: move every transaction and scheduled transaction from the
   * source payees onto one target payee. YNAB's API has no merge (and cannot
   * delete payees), so this reassigns by payee_id; the emptied source payees
   * stay behind for the user to delete in the app.
   *
   * Request budget, whatever the size of the batch: one read each of payees,
   * transactions and scheduled transactions, one rename per target that does
   * not exist yet, one PATCH per 100 transactions, one PUT per scheduled
   * transaction moved. That keeps a large cleanup inside the 200/hour limit.
   */
  async mergePayees(
    budgetId: string,
    merges: Array<{ targetName: string; sourcePayeeIds: string[] }>,
    opts: { noteToMemo: boolean; dryRun: boolean },
  ): Promise<unknown> {
    if (!opts.dryRun) this.#assertWritable();
    const base = `/plans/${enc(budgetId)}`;
    const { payees } = await this.#get<{ payees: Payee[] }>(`${base}/payees`);
    const live = payees.filter((p) => !p.deleted);
    const byId = new Map(live.map((p) => [p.id, p]));

    // ---- validate and resolve each merge's target
    const seen = new Set<string>();
    const plans = merges.map((m) => {
      const targetName = m.targetName.trim();
      if (!targetName) throw new YnabError('target_name cannot be empty.');
      const sources: Payee[] = [];
      for (const id of new Set(m.sourcePayeeIds)) {
        const p = byId.get(id);
        if (!p) throw new YnabError(`Payee ${id} was not found. list_payees returns the valid ids.`);
        if (p.transfer_account_id) throw new YnabError(`"${p.name}" is a transfer payee and cannot be merged.`);
        if (seen.has(id)) throw new YnabError(`Payee "${p.name}" appears in more than one merge.`);
        seen.add(id);
        sources.push(p);
      }
      const existing = live.find((p) => p.name === targetName);
      if (existing?.transfer_account_id) {
        throw new YnabError(`"${targetName}" is a transfer payee; pick a different target name.`);
      }
      // No payee has the target name yet: rename one source into it, preferring
      // one without a Venmo-style note so no note lives only in a payee name.
      const renamed = existing ? undefined : (sources.find((p) => !splitNote(p.name).note) ?? sources[0]);
      const target = existing ?? renamed!;
      return { targetName, target, renamed, sources: sources.filter((p) => p.id !== target.id || renamed) };
    });

    const [{ transactions }, { scheduled_transactions: scheduled }] = await Promise.all([
      this.#get<{ transactions: TransactionDetail[] }>(`${base}/transactions`, { since_date: FULL_HISTORY_SINCE }),
      this.#get<{ scheduled_transactions: ScheduledTransactionDetail[] }>(`${base}/scheduled_transactions`),
    ]);

    // ---- build every edit before writing anything
    const plannedTxns: Array<Record<string, unknown>> = [];
    const plannedScheduled: Array<{ id: string; body: Record<string, unknown> }> = [];
    const report = plans.map(({ targetName, target, renamed, sources }) => {
      const stats = { transactions: 0, scheduled: 0, memos: 0, split_lines_skipped: 0 };
      for (const src of sources) {
        const note = opts.noteToMemo ? splitNote(src.name).note : undefined;
        const moving = src.id !== target.id; // the renamed source only needs its notes kept
        for (const t of transactions) {
          if (t.deleted) continue;
          stats.split_lines_skipped += (t.subtransactions ?? []).filter(
            (st) => !st.deleted && st.payee_id === src.id,
          ).length;
          if (t.payee_id !== src.id) continue;
          const memo = mergeMemo(t.memo, note);
          if (!moving && memo === undefined) continue;
          plannedTxns.push({ id: t.id, ...(moving ? { payee_id: target.id } : {}), ...(memo !== undefined ? { memo } : {}) });
          if (moving) stats.transactions++;
          if (memo !== undefined) stats.memos++;
        }
        for (const s of scheduled) {
          if (s.deleted || s.payee_id !== src.id || (s.subtransactions ?? []).length > 0) continue;
          const memo = mergeMemo(s.memo, note);
          if (!moving && memo === undefined) continue;
          plannedScheduled.push({
            id: s.id,
            body: {
              account_id: s.account_id,
              date: s.date_next,
              amount: s.amount,
              frequency: s.frequency,
              payee_id: target.id,
              category_id: s.category_id ?? null,
              memo: memo ?? s.memo ?? null,
              flag_color: s.flag_color ?? null,
            },
          });
          stats.scheduled++;
        }
      }
      return {
        target: targetName,
        target_payee_id: target.id,
        ...(renamed ? { created_by_renaming: renamed.name } : {}),
        merged_payees: sources.filter((p) => p.id !== target.id).map((p) => p.name),
        ...stats,
      };
    });

    const writesNeeded =
      plans.filter((p) => p.renamed).length + Math.ceil(plannedTxns.length / 100) + plannedScheduled.length;
    if (opts.dryRun) {
      return {
        dry_run: true,
        merges: report,
        totals: { transactions: plannedTxns.length, scheduled: plannedScheduled.length },
        api_requests_needed: writesNeeded,
      };
    }
    // A Worker invocation may make only ~50 outbound requests on the free plan;
    // three reads are already spent. Refuse up front rather than fail halfway.
    if (writesNeeded > 45) {
      throw new YnabError(
        `This batch needs ${writesNeeded} write requests, more than one call can make. Split the merges into ` +
          'smaller batches (fewer targets that need creating, or fewer scheduled transactions per call).',
      );
    }

    // ---- write: renames first, so payee_id targets exist under their final names
    for (const p of plans) {
      if (p.renamed && p.renamed.name !== p.targetName) {
        await this.#send('PATCH', `${base}/payees/${enc(p.renamed.id)}`, { payee: { name: p.targetName } });
      }
    }
    for (let i = 0; i < plannedTxns.length; i += 100) {
      await this.#send('PATCH', `${base}/transactions`, { transactions: plannedTxns.slice(i, i + 100) });
    }
    for (const s of plannedScheduled) {
      await this.#send('PUT', `${base}/scheduled_transactions/${enc(s.id)}`, { scheduled_transaction: s.body });
    }

    const emptied = report.flatMap((r) => r.merged_payees);
    return {
      merged: report,
      totals: { transactions: plannedTxns.length, scheduled: plannedScheduled.length },
      emptied_payees: emptied.length,
      next_step:
        'The API cannot delete payees, so the emptied ones remain with no transactions. Delete or combine them in ' +
        'YNAB under Manage Payees.',
    };
  }

  // ---------------------------------------------------------------- writes

  async createTransaction(
    budgetId: string,
    input: {
      accountId: string;
      date: string;
      amount: number;
      payeeName?: string;
      categoryId?: string;
      memo?: string;
      cleared?: 'cleared' | 'uncleared' | 'reconciled';
      approved?: boolean;
      transferAccountId?: string;
    },
  ): Promise<unknown> {
    this.#assertWritable();
    const currency = await this.currencyFor(budgetId);
    const transfer = input.transferAccountId
      ? transferBody(await this.#accounts(budgetId), input.accountId, input.transferAccountId, input)
      : {};

    const data = await this.#send<{ transaction: TransactionDetail | null }>(
      'POST',
      `/plans/${enc(budgetId)}/transactions`,
      {
        transaction: {
          account_id: input.accountId,
          date: input.date,
          amount: input.amount,
          cleared: input.cleared ?? 'uncleared',
          approved: input.approved ?? true,
          ...(input.payeeName ? { payee_name: input.payeeName } : {}),
          ...(input.categoryId ? { category_id: input.categoryId } : {}),
          ...(input.memo ? { memo: input.memo } : {}),
          ...transfer,
        },
      },
    );

    const created = data.transaction;
    if (!created) throw new YnabError('YNAB accepted the request but returned no transaction.');

    return { created: true, ...this.#formatTxn(created, currency) };
  }

  async updateBudgetedAmount(
    budgetId: string,
    month: string,
    categoryId: string,
    budgetedMilliunits: number,
  ): Promise<unknown> {
    this.#assertWritable();
    const currency = await this.currencyFor(budgetId);

    const data = await this.#send<{ category: Category }>(
      'PATCH',
      `/plans/${enc(budgetId)}/months/${enc(month)}/categories/${enc(categoryId)}`,
      { category: { budgeted: budgetedMilliunits } },
    );

    const c = data.category;
    return {
      updated: true,
      month,
      id: c.id,
      name: c.name,
      budgeted: this.money(c.budgeted, currency),
      activity: this.money(c.activity, currency),
      balance: this.money(c.balance, currency),
    };
  }

  /**
   * Move budgeted money between two categories in a month.
   *
   * YNAB has no single "move money" write endpoint, so this reads both
   * categories and writes both back. It is not atomic: if the second write
   * fails, the first is rolled back on a best-effort basis and the error says
   * exactly what happened.
   */
  async moveMoney(
    budgetId: string,
    month: string,
    fromCategoryId: string,
    toCategoryId: string,
    amountMilliunits: number,
  ): Promise<unknown> {
    this.#assertWritable();

    if (fromCategoryId === toCategoryId) {
      throw new YnabError('The source and destination categories are the same.');
    }
    if (amountMilliunits <= 0) {
      throw new YnabError('Amount to move must be greater than zero.');
    }

    const currency = await this.currencyFor(budgetId);
    const monthPath = `/plans/${enc(budgetId)}/months/${enc(month)}/categories`;

    const [fromResponse, toResponse] = await Promise.all([
      this.#get<{ category: Category }>(`${monthPath}/${enc(fromCategoryId)}`),
      this.#get<{ category: Category }>(`${monthPath}/${enc(toCategoryId)}`),
    ]);

    const from = fromResponse.category;
    const to = toResponse.category;
    const fromOriginal = from.budgeted;

    await this.#send('PATCH', `${monthPath}/${enc(fromCategoryId)}`, {
      category: { budgeted: fromOriginal - amountMilliunits },
    });

    try {
      await this.#send('PATCH', `${monthPath}/${enc(toCategoryId)}`, {
        category: { budgeted: to.budgeted + amountMilliunits },
      });
    } catch (err) {
      try {
        await this.#send('PATCH', `${monthPath}/${enc(fromCategoryId)}`, {
          category: { budgeted: fromOriginal },
        });
      } catch {
        throw new YnabError(
          `Moved money out of "${from.name}" but failed to add it to "${to.name}", and the rollback also failed. ` +
            `"${from.name}" is now budgeted ${this.money(fromOriginal - amountMilliunits, currency)} — fix this in YNAB directly.`,
        );
      }
      throw new YnabError(
        `Could not add money to "${to.name}" (${(err as Error).message}). No change was made — "${from.name}" was restored.`,
      );
    }

    return {
      moved: this.money(amountMilliunits, currency),
      month,
      from: {
        name: from.name,
        budgeted_before: this.money(fromOriginal, currency),
        budgeted_after: this.money(fromOriginal - amountMilliunits, currency),
      },
      to: {
        name: to.name,
        budgeted_before: this.money(to.budgeted, currency),
        budgeted_after: this.money(to.budgeted + amountMilliunits, currency),
      },
    };
  }

  async updateTransaction(
    budgetId: string,
    transactionId: string,
    fields: TxnEditFields,
  ): Promise<unknown> {
    this.#assertWritable();
    const body = txnBody(fields);
    if (fields.transferAccountId) {
      const [existing, accounts] = await Promise.all([this.#txn(budgetId, transactionId), this.#accounts(budgetId)]);
      Object.assign(body, transferBody(accounts, existing.account_id, fields.transferAccountId, fields, existing.category_id));
    }
    if (Object.keys(body).length === 0) {
      throw new YnabError('No fields to update were provided.');
    }

    const currency = await this.currencyFor(budgetId);
    const data = await this.#send<{ transaction: TransactionDetail }>(
      'PUT',
      `/plans/${enc(budgetId)}/transactions/${enc(transactionId)}`,
      { transaction: body },
    );

    return { updated: true, transaction: this.#formatTxn(data.transaction, currency) };
  }

  async bulkUpdateTransactions(
    budgetId: string,
    updates: Array<{ transactionId: string } & TxnEditFields>,
  ): Promise<unknown> {
    this.#assertWritable();
    if (updates.length === 0) throw new YnabError('No updates were provided.');

    // Transfers need each source transaction's account. Two requests total,
    // never one per entry, to stay inside the 200/hour rate limit.
    const hasTransfer = updates.some((u) => u.transferAccountId);
    const [accounts, existing] = hasTransfer
      ? await Promise.all([
          this.#accounts(budgetId),
          this.#get<{ transactions: TransactionDetail[] }>(`/plans/${enc(budgetId)}/transactions`, {
            since_date: FULL_HISTORY_SINCE,
          }),
        ])
      : [[], { transactions: [] }];
    const byId = new Map(existing.transactions.map((t) => [t.id, t]));

    const transactions = updates.map((u) => {
      const body = txnBody(u);
      if (u.transferAccountId) {
        const source = byId.get(u.transactionId);
        if (!source) throw new YnabError(`Transaction ${u.transactionId} was not found.`);
        Object.assign(body, transferBody(accounts, source.account_id, u.transferAccountId, u, source.category_id));
      }
      if (Object.keys(body).length === 0) {
        throw new YnabError(`No fields to update were given for transaction ${u.transactionId}.`);
      }
      return { id: u.transactionId, ...body };
    });

    const currency = await this.currencyFor(budgetId);
    const data = await this.#send<{ transactions: TransactionDetail[]; transaction_ids?: string[] }>(
      'PATCH',
      `/plans/${enc(budgetId)}/transactions`,
      { transactions },
    );

    return {
      updated: data.transaction_ids?.length ?? data.transactions.length,
      transactions: data.transactions.map((t) => this.#formatTxn(t, currency)),
    };
  }

  async deleteTransaction(budgetId: string, transactionId: string): Promise<unknown> {
    this.#assertWritable();
    const currency = await this.currencyFor(budgetId);
    const data = await this.#delete<{ transaction: TransactionDetail }>(
      `/plans/${enc(budgetId)}/transactions/${enc(transactionId)}`,
    );
    return { deleted: true, transaction: this.#formatTxn(data.transaction, currency) };
  }

  // --------------------------------------------------- scheduled transactions

  async listScheduledTransactions(budgetId: string, accountId?: string): Promise<unknown> {
    const [currency, data] = await Promise.all([
      this.currencyFor(budgetId),
      this.#get<{ scheduled_transactions: ScheduledTransactionDetail[] }>(
        `/plans/${enc(budgetId)}/scheduled_transactions`,
      ),
    ]);

    const live = data.scheduled_transactions.filter(
      (s) => !s.deleted && (!accountId || s.account_id === accountId),
    );
    return {
      returned: live.length,
      scheduled_transactions: live.map((s) => this.#formatScheduled(s, currency)),
    };
  }

  async createScheduledTransaction(
    budgetId: string,
    input: { accountId: string; date: string } & ScheduledEditFields,
  ): Promise<unknown> {
    this.#assertWritable();
    const currency = await this.currencyFor(budgetId);
    const transfer = input.transferAccountId
      ? transferBody(await this.#accounts(budgetId), input.accountId, input.transferAccountId, input)
      : {};
    const data = await this.#send<{ scheduled_transaction: ScheduledTransactionDetail }>(
      'POST',
      `/plans/${enc(budgetId)}/scheduled_transactions`,
      { scheduled_transaction: { account_id: input.accountId, date: input.date, ...scheduledBody(input), ...transfer } },
    );
    return { created: true, scheduled_transaction: this.#formatScheduled(data.scheduled_transaction, currency) };
  }

  async updateScheduledTransaction(
    budgetId: string,
    scheduledTransactionId: string,
    fields: ScheduledEditFields,
  ): Promise<unknown> {
    this.#assertWritable();
    const body = scheduledBody(fields);
    if (fields.transferAccountId) {
      const [{ scheduled_transaction: existing }, accounts] = await Promise.all([
        this.#get<{ scheduled_transaction: ScheduledTransactionDetail }>(
          `/plans/${enc(budgetId)}/scheduled_transactions/${enc(scheduledTransactionId)}`,
        ),
        this.#accounts(budgetId),
      ]);
      const source = fields.accountId ?? existing.account_id;
      Object.assign(body, transferBody(accounts, source, fields.transferAccountId, fields, existing.category_id));
    }
    if (Object.keys(body).length === 0) {
      throw new YnabError('No fields to update were provided.');
    }

    const currency = await this.currencyFor(budgetId);
    const data = await this.#send<{ scheduled_transaction: ScheduledTransactionDetail }>(
      'PUT',
      `/plans/${enc(budgetId)}/scheduled_transactions/${enc(scheduledTransactionId)}`,
      { scheduled_transaction: body },
    );
    return { updated: true, scheduled_transaction: this.#formatScheduled(data.scheduled_transaction, currency) };
  }

  async deleteScheduledTransaction(budgetId: string, scheduledTransactionId: string): Promise<unknown> {
    this.#assertWritable();
    const currency = await this.currencyFor(budgetId);
    const data = await this.#delete<{ scheduled_transaction: ScheduledTransactionDetail }>(
      `/plans/${enc(budgetId)}/scheduled_transactions/${enc(scheduledTransactionId)}`,
    );
    return { deleted: true, scheduled_transaction: this.#formatScheduled(data.scheduled_transaction, currency) };
  }

  // ------------------------------------------------- category & payee edits

  async updateCategory(
    budgetId: string,
    categoryId: string,
    fields: {
      name?: string;
      note?: string;
      categoryGroupId?: string;
      goalTargetMilliunits?: number;
      goalTargetDate?: string;
    },
  ): Promise<unknown> {
    this.#assertWritable();
    const body: Record<string, unknown> = {};
    if (fields.name !== undefined) body.name = fields.name;
    if (fields.note !== undefined) body.note = fields.note;
    if (fields.categoryGroupId !== undefined) body.category_group_id = fields.categoryGroupId;
    if (fields.goalTargetMilliunits !== undefined) body.goal_target = fields.goalTargetMilliunits;
    if (fields.goalTargetDate !== undefined) body.goal_target_date = fields.goalTargetDate;
    if (Object.keys(body).length === 0) {
      throw new YnabError('Provide at least one field to update.');
    }

    const data = await this.#send<{ category: Category }>(
      'PATCH',
      `/plans/${enc(budgetId)}/categories/${enc(categoryId)}`,
      { category: body },
    );
    return { updated: true, id: data.category.id, name: data.category.name };
  }

  async createCategory(budgetId: string, name: string, categoryGroupId: string): Promise<unknown> {
    this.#assertWritable();
    const data = await this.#send<{ category: Category }>(
      'POST',
      `/plans/${enc(budgetId)}/categories`,
      { category: { name, category_group_id: categoryGroupId } },
    );
    return { created: true, id: data.category.id, name: data.category.name };
  }

  async createCategoryGroup(budgetId: string, name: string): Promise<unknown> {
    this.#assertWritable();
    const data = await this.#send<{ category_group: CategoryGroup }>(
      'POST',
      `/plans/${enc(budgetId)}/category_groups`,
      { category_group: { name } },
    );
    return { created: true, id: data.category_group.id, name: data.category_group.name };
  }

  async updateCategoryGroup(budgetId: string, groupId: string, name: string): Promise<unknown> {
    this.#assertWritable();
    const data = await this.#send<{ category_group: CategoryGroup }>(
      'PATCH',
      `/plans/${enc(budgetId)}/category_groups/${enc(groupId)}`,
      { category_group: { name } },
    );
    return { updated: true, id: data.category_group.id, name: data.category_group.name };
  }

  async updatePayee(budgetId: string, payeeId: string, name: string): Promise<unknown> {
    this.#assertWritable();
    const data = await this.#send<{ payee: Payee }>(
      'PATCH',
      `/plans/${enc(budgetId)}/payees/${enc(payeeId)}`,
      { payee: { name } },
    );
    return { updated: true, id: data.payee.id, name: data.payee.name };
  }

  // -------------------------------------------------------- accounts & meta

  async createAccount(
    budgetId: string,
    name: string,
    type: string,
    balanceMilliunits: number,
  ): Promise<unknown> {
    this.#assertWritable();
    const currency = await this.currencyFor(budgetId);
    const data = await this.#send<{ account: Account }>(
      'POST',
      `/plans/${enc(budgetId)}/accounts`,
      { account: { name, type, balance: balanceMilliunits } },
    );
    const a = data.account;
    return {
      created: true,
      id: a.id,
      name: a.name,
      type: a.type,
      balance: this.money(a.balance, currency),
    };
  }

  async importTransactions(budgetId: string): Promise<unknown> {
    this.#assertWritable();
    const data = await this.#send<{ transaction_ids: string[] }>(
      'POST',
      `/plans/${enc(budgetId)}/transactions/import`,
      {},
    );
    return {
      imported: data.transaction_ids.length,
      transaction_ids: data.transaction_ids,
      note:
        data.transaction_ids.length === 0
          ? 'No new transactions were available to import. This only pulls from linked (Direct Import) accounts.'
          : undefined,
    };
  }

  async listMonths(budgetId: string): Promise<unknown> {
    const [currency, data] = await Promise.all([
      this.currencyFor(budgetId),
      this.#get<{ months: MonthSummaryRow[] }>(`/plans/${enc(budgetId)}/months`),
    ]);
    return data.months
      .filter((m) => !m.deleted)
      .map((m) => ({
        month: m.month,
        income: this.money(m.income, currency),
        budgeted: this.money(m.budgeted, currency),
        activity: this.money(m.activity, currency),
        to_be_budgeted: this.money(m.to_be_budgeted, currency),
        age_of_money: m.age_of_money ?? undefined,
        note: m.note ?? undefined,
      }));
  }

  async getUser(): Promise<unknown> {
    const data = await this.#get<{ user: { id: string } }>('/user');
    return { id: data.user.id };
  }

  async getBudgetSettings(budgetId: string): Promise<unknown> {
    const data = await this.#get<{ settings: PlanSettings }>(`/plans/${enc(budgetId)}/settings`);
    return {
      date_format: data.settings.date_format?.format,
      currency: data.settings.currency_format?.iso_code,
      currency_symbol: data.settings.currency_format?.currency_symbol,
      decimal_digits: data.settings.currency_format?.decimal_digits,
    };
  }

  // ------------------------------------------------------------- internals

  #formatTxn(t: TransactionDetail, currency: CurrencyFormat) {
    return {
      id: t.id,
      date: t.date,
      amount: this.money(t.amount, currency),
      payee: t.payee_name ?? undefined,
      category: t.category_name ?? undefined,
      account: t.account_name,
      memo: t.memo ?? undefined,
      cleared: t.cleared,
      approved: t.approved,
      ...(t.transfer_account_id
        ? {
            // YNAB names a transfer payee "Transfer : <account name>".
            transfer_account: t.payee_name?.replace(/^Transfer : /, ''),
            transfer_account_id: t.transfer_account_id,
            transfer_transaction_id: t.transfer_transaction_id ?? undefined,
          }
        : {}),
    };
  }

  #formatScheduled(s: ScheduledTransactionDetail, currency: CurrencyFormat) {
    return {
      id: s.id,
      account: s.account_name,
      payee: s.payee_name ?? undefined,
      category: s.category_name ?? undefined,
      amount: this.money(s.amount, currency),
      frequency: s.frequency,
      date_next: s.date_next,
      date_first: s.date_first,
      memo: s.memo ?? undefined,
      flag_color: s.flag_color ?? undefined,
      transfer_account_id: s.transfer_account_id ?? undefined,
    };
  }

  async #accounts(budgetId: string): Promise<Account[]> {
    return (await this.#get<{ accounts: Account[] }>(`/plans/${enc(budgetId)}/accounts`)).accounts;
  }

  async #txn(budgetId: string, transactionId: string): Promise<TransactionDetail> {
    return (
      await this.#get<{ transaction: TransactionDetail }>(
        `/plans/${enc(budgetId)}/transactions/${enc(transactionId)}`,
      )
    ).transaction;
  }

  #assertWritable(): void {
    if (!this.#allowWrites) {
      throw new YnabError(
        'This server is running in read-only mode. Set YNAB_ALLOW_WRITES=true in wrangler.jsonc and redeploy to enable changes.',
      );
    }
  }

  #get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return this.#request<T>('GET', url.toString());
  }

  #send<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown): Promise<T> {
    return this.#request<T>(method, API_BASE + path, body);
  }

  #delete<T>(path: string): Promise<T> {
    return this.#request<T>('DELETE', API_BASE + path);
  }

  async #request<T>(method: string, url: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new YnabError(`Could not reach the YNAB API: ${(err as Error).message}`);
    }

    const text = await response.text();

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new YnabError(
        `Got a non-JSON response from the YNAB API (HTTP ${response.status}). This usually means something ` +
          'between this Worker and YNAB intercepted the request, or YNAB is returning an outage page.',
      );
    }

    if (!response.ok) throw toYnabError(parsed, response.status);

    return (parsed as { data: T }).data;
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Build a YNAB transaction body from only the fields the caller set. Omitted
 * fields are left out entirely so a PUT/PATCH never clobbers what it did not
 * mean to touch — YNAB leaves unspecified fields unchanged.
 */
export function txnBody(f: TxnEditFields): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (f.approved !== undefined) b.approved = f.approved;
  if (f.categoryId !== undefined) b.category_id = f.categoryId;
  if (f.amountMilliunits !== undefined) b.amount = f.amountMilliunits;
  if (f.date !== undefined) b.date = f.date;
  if (f.payeeName !== undefined) b.payee_name = f.payeeName;
  if (f.memo !== undefined) b.memo = f.memo;
  if (f.cleared !== undefined) b.cleared = f.cleared;
  if (f.flagColor !== undefined) b.flag_color = f.flagColor;
  return b;
}

/**
 * Venmo imports put the payment note in the payee name: `Caro Thurin "korean bbq"`.
 * Split that into the person and the note so a merge can keep the note.
 */
export function splitNote(name: string): { base: string; note?: string } {
  const m = /^(.*?\S)\s*"(.+)"\s*$/s.exec(name);
  return m?.[1] && m[2] ? { base: m[1], note: m[2].trim() } : { base: name };
}

/**
 * The memo to write when carrying a note over, or undefined when nothing
 * changes: an empty memo takes the note; an existing memo keeps its text and
 * gains the note after a separator, unless it already contains it. Capped at
 * YNAB's 500-character memo limit.
 */
export function mergeMemo(memo: string | null | undefined, note: string | undefined): string | undefined {
  if (!note) return undefined;
  const current = (memo ?? '').trim();
  if (current.includes(note)) return undefined;
  return (current ? `${current} · ${note}` : note).slice(0, 500);
}

/** Same partial-body rule for scheduled transactions (no cleared/approved). */
export function scheduledBody(f: ScheduledEditFields): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (f.accountId !== undefined) b.account_id = f.accountId;
  if (f.amountMilliunits !== undefined) b.amount = f.amountMilliunits;
  if (f.date !== undefined) b.date = f.date;
  if (f.frequency !== undefined) b.frequency = f.frequency;
  if (f.categoryId !== undefined) b.category_id = f.categoryId;
  if (f.payeeName !== undefined) b.payee_name = f.payeeName;
  if (f.memo !== undefined) b.memo = f.memo;
  if (f.flagColor !== undefined) b.flag_color = f.flagColor;
  return b;
}

/**
 * Validate a transfer from `sourceId` to `destId` and return the body fields
 * that make a transaction one: the destination's transfer payee, plus an
 * explicit null category when both sides are on-budget (such transfers carry
 * no category). `existingCategoryId` is the category already on a transaction
 * being converted, which satisfies the on-budget -> tracking category rule.
 */
export function transferBody(
  accounts: Array<Pick<Account, 'id' | 'name' | 'on_budget' | 'closed' | 'deleted' | 'transfer_payee_id'>>,
  sourceId: string,
  destId: string,
  f: { payeeName?: string; categoryId?: string },
  existingCategoryId?: string | null,
): Record<string, unknown> {
  if (f.payeeName !== undefined) {
    throw new YnabError('Pass either payee_name or transfer_account_id, not both — a transfer’s payee is the destination account.');
  }
  if (destId === sourceId) {
    throw new YnabError('transfer_account_id is the same account the transaction is on. Pick a different destination account.');
  }
  const source = accounts.find((a) => a.id === sourceId && !a.deleted);
  const dest = accounts.find((a) => a.id === destId && !a.deleted);
  if (!source) throw new YnabError(`Account ${sourceId} was not found. list_accounts returns the valid ids.`);
  if (!dest) throw new YnabError(`Transfer account ${destId} was not found. list_accounts returns the valid ids.`);
  if (dest.closed) throw new YnabError(`"${dest.name}" is closed; transfers to a closed account are not allowed.`);
  if (!dest.transfer_payee_id) throw new YnabError(`YNAB returned no transfer payee for "${dest.name}".`);

  if (source.on_budget && dest.on_budget) {
    if (f.categoryId !== undefined) {
      throw new YnabError(
        `"${source.name}" and "${dest.name}" are both budget accounts, so a transfer between them has no category. Omit category_id.`,
      );
    }
    return { payee_id: dest.transfer_payee_id, category_id: null };
  }
  if (source.on_budget && !(f.categoryId ?? existingCategoryId)) {
    throw new YnabError(
      `"${dest.name}" is a tracking (off-budget) account, so the transfer out of budget account "${source.name}" ` +
        'needs a category_id — usually the category that funds that account (e.g. its loan or debt category).',
    );
  }
  return { payee_id: dest.transfer_payee_id };
}

/** The envelope YNAB returns on an error: { error: { id: "404.2", name, detail } }. */
interface YnabErrorEnvelope {
  error: { id?: string; name?: string; detail?: string };
}

function isErrorEnvelope(value: unknown): value is YnabErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as YnabErrorEnvelope).error === 'object' &&
    (value as YnabErrorEnvelope).error !== null
  );
}

export function toYnabError(body: unknown, httpStatus: number): YnabError {
  const detail = isErrorEnvelope(body) ? body.error.detail : undefined;
  const name = isErrorEnvelope(body) ? body.error.name : undefined;

  switch (httpStatus) {
    case 401:
      return new YnabError(
        'YNAB rejected the access token. The YNAB_ACCESS_TOKEN secret is missing, wrong, or was revoked. ' +
          'Generate a new Personal Access Token in YNAB under Account Settings > Developer Settings.',
        401,
      );
    case 403:
      return new YnabError(
        detail ?? 'YNAB refused this request. A trial subscription cannot make changes through the API.',
        403,
      );
    case 404:
      return new YnabError(
        `${detail ?? 'Not found'}. Check the budget, account, or category id — list_budgets, list_accounts ` +
          'and list_categories return the valid ones.',
        404,
      );
    case 409:
      return new YnabError(
        detail ?? 'Conflict: this resource was changed elsewhere. Re-read it and try again.',
        409,
      );
    case 429:
      return new YnabError(
        'YNAB rate limit reached — a token is allowed 200 requests per hour. Wait a few minutes before retrying.',
        429,
      );
    case 500:
      return new YnabError('YNAB had an internal error. Try again shortly.', 500);
    default:
      return new YnabError(detail ?? name ?? `YNAB returned HTTP ${httpStatus}.`, httpStatus);
  }
}
