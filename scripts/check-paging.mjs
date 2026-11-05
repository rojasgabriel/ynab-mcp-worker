#!/usr/bin/env node
// Offline checks for list_transactions paging (offset, until_date), with fetch mocked.
// Usage: node --experimental-strip-types --no-warnings scripts/check-paging.mjs
import assert from 'node:assert/strict';
import { YnabService } from '../src/ynab.ts';

const TXNS = [];
for (let i = 0; i < 450; i++) {
  const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  TXNS.push({ id: `t${String(i).padStart(3, '0')}`, date: d, amount: -1000, deleted: i === 7, payee_name: 'X',
    category_name: 'C', account_name: 'A', cleared: 'cleared', approved: true });
}

let lastSince;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const path = u.pathname.replace('/v1/plans/b', '');
  lastSince = u.searchParams.get('since_date');
  const data = path === '/settings' ? { settings: { currency_format: { iso_code: 'USD', decimal_digits: 2 } } }
    : path === '/transactions' ? { transactions: TXNS.filter((t) => !lastSince || t.date >= lastSince) }
    : {};
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const ynab = new YnabService({ YNAB_ACCESS_TOKEN: 'x', YNAB_ALLOW_WRITES: 'false' });
const live = 449;

// Paging with offset walks the whole history exactly once, newest first.
const seen = new Set();
let offset = 0, pages = 0, prevDate = '9999';
for (;;) {
  const r = await ynab.listTransactions('b', { limit: 200, offset });
  assert.equal(r.total_matching, live);
  for (const t of r.transactions) {
    assert.ok(!seen.has(t.id), `duplicate ${t.id} at offset ${offset}`);
    assert.ok(t.date <= prevDate, 'rows must stay newest-first across pages');
    prevDate = t.date; seen.add(t.id);
  }
  pages++;
  if (!r.has_more) break;
  offset += r.returned;
}
assert.equal(seen.size, live, 'offset paging should cover every live transaction');
assert.equal(pages, 3);

// until_date caps the window on the upper end (inclusive); since_date still goes to YNAB.
const win = await ynab.listTransactions('b', { sinceDate: '2024-02-01', untilDate: '2024-02-29', limit: 200 });
assert.equal(lastSince, '2024-02-01');
assert.equal(win.total_matching, 29);
assert.ok(win.transactions.every((t) => t.date >= '2024-02-01' && t.date <= '2024-02-29'));
assert.equal(win.has_more, false);

// Defaults are unchanged: no offset means the newest rows, and offset is reported as 0.
const first = await ynab.listTransactions('b', { limit: 5 });
assert.equal(first.offset, 0);
assert.equal(first.transactions[0].date, TXNS[449].date);

console.log(`paging checks passed (${pages} pages, ${seen.size} transactions)`);
