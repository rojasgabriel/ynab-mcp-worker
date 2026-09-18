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

interface TransactionDetail {
  id: string;
  date: string;
  amount: number;
  memo?: string | null;
  cleared: string;
  approved: boolean;
  deleted: boolean;
  account_name: string;
  payee_name?: string | null;
  category_name?: string | null;
}

interface Payee {
  id: string;
  name: string;
  deleted: boolean;
  transfer_account_id?: string | null;
}

// ---------------------------------------------------------------------------

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
      type?: 'uncategorized' | 'unapproved';
      limit: number;
    },
  ): Promise<unknown> {
    const base = `/plans/${enc(budgetId)}`;
    const path = options.accountId
      ? `${base}/accounts/${enc(options.accountId)}/transactions`
      : options.categoryId
        ? `${base}/categories/${enc(options.categoryId)}/transactions`
        : `${base}/transactions`;

    const query: Record<string, string> = {};
    if (options.sinceDate) query.since_date = options.sinceDate;
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
      transactions: rows.map((t) => ({
        id: t.id,
        date: t.date,
        amount: this.money(t.amount, currency),
        amount_milliunits: t.amount,
        payee: t.payee_name ?? undefined,
        category: t.category_name ?? undefined,
        account: t.account_name,
        memo: t.memo ?? undefined,
        cleared: t.cleared,
        approved: t.approved,
      })),
    };
  }

  async listPayees(budgetId: string): Promise<unknown> {
    const data = await this.#get<{ payees: Payee[] }>(`/plans/${enc(budgetId)}/payees`);
    return data.payees
      .filter((p) => !p.deleted)
      .map((p) => ({ id: p.id, name: p.name, transfer_account_id: p.transfer_account_id }));
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
    },
  ): Promise<unknown> {
    this.#assertWritable();
    const currency = await this.currencyFor(budgetId);

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
        },
      },
    );

    const created = data.transaction;
    if (!created) throw new YnabError('YNAB accepted the request but returned no transaction.');

    return {
      created: true,
      id: created.id,
      date: created.date,
      amount: this.money(created.amount, currency),
      payee: created.payee_name ?? undefined,
      category: created.category_name ?? undefined,
      account: created.account_name,
    };
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

  // ------------------------------------------------------------- internals

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
