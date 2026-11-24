#!/usr/bin/env node
// Offline checks for transfer support, with fetch mocked.
// Usage: node --experimental-strip-types --no-warnings scripts/check-transfer.mjs
import assert from 'node:assert/strict';
import { YnabService } from '../src/ynab.ts';

const acct = (id, on_budget, extra = {}) =>
  ({ id, name: id, on_budget, closed: false, deleted: false, balance: 0, transfer_payee_id: `tp-${id}`, ...extra });
const ACCOUNTS = [acct('chk', true), acct('sav', true), acct('loan', false)];
const TXNS = [
  { id: 't1', account_id: 'sav', category_id: 'groceries', date: '2026-09-30', amount: -1000 },
  { id: 't2', account_id: 'chk', category_id: null, date: '2026-09-30', amount: -2000 },
];

let calls;
let loseCreateResponse = false;
const postedTransfers = [];
const scheduled = { id: 's1', account_id: 'chk', category_id: null, date_first: '2026-09-30', date_next: '2026-10-30', frequency: 'monthly', amount: -2000 };
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname.replace('/v1/plans/b', '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path, body });
  const echo = (t) => ({ id: 't', date: '2026-09-30', amount: 0, cleared: 'uncleared', approved: true,
    account_name: 'x', deleted: false, ...t, transfer_account_id: t.payee_id?.slice(3), transfer_transaction_id: 'tt' });
  if (init.method === 'POST' && body?.transaction?.payee_id) {
    postedTransfers.push(body.transaction);
    if (loseCreateResponse) throw new Error('response lost after saving');
  }
  const data =
    path === '/v1/plans' ? { plans: [] }
    : path === '/accounts' ? { accounts: ACCOUNTS }
    : path === '/transactions' && init.method === 'GET' ? { transactions: TXNS }
    : path.startsWith('/transactions/') && init.method === 'GET' ? { transaction: TXNS.find((t) => path.endsWith(t.id)) }
    : path === '/scheduled_transactions/s1' && init.method === 'GET' ? { scheduled_transaction: scheduled }
    : body?.scheduled_transaction ? { scheduled_transaction: { ...scheduled, ...echo(body.scheduled_transaction) } }
    : body?.transaction ? { transaction: echo(body.transaction) }
    : body?.transactions ? { transactions: body.transactions.map(echo) }
    : assert.fail(`unexpected ${init.method} ${path}`);
  return new Response(JSON.stringify({ data }));
};

const ynab = new YnabService({ YNAB_ACCESS_TOKEN: 'x', YNAB_ALLOW_WRITES: 'true' });
const writes = () => calls.filter((c) => c.method !== 'GET');
const reset = () => { calls = []; };

// on-budget -> on-budget: payee_id is the transfer payee, no category, link returned
reset();
const created = await ynab.createTransaction('b', { accountId: 'sav', transferAccountId: 'chk', date: '2026-09-30', amount: -494640 });
const sent = writes()[0].body.transaction;
assert.equal(sent.payee_id, 'tp-chk');
assert.equal(sent.payee_name, undefined);
assert.equal(sent.category_id, null);
assert.equal(created.transfer_account_id, 'chk');
assert.equal(created.transfer_transaction_id, 'tt');

// A transport failure can happen after YNAB saves the transfer. The worker
// sends one POST per call, so a blind caller retry can save a second transfer.
reset();
postedTransfers.length = 0;
const transfer = { accountId: 'sav', transferAccountId: 'chk', date: '2026-09-30', amount: -500 };
loseCreateResponse = true;
await assert.rejects(ynab.createTransaction('b', transfer), /response lost after saving/);
assert.equal(writes().length, 1);
assert.equal(postedTransfers.length, 1);
loseCreateResponse = false;
await ynab.createTransaction('b', transfer);
assert.deepEqual(postedTransfers, [postedTransfers[0], postedTransfers[0]]);

// rejections, and none of them reach YNAB with a write
reset();
await assert.rejects(ynab.createTransaction('b', { accountId: 'chk', transferAccountId: 'loan', date: '2026-09-30', amount: -1 }), /needs a category_id/);
await assert.rejects(ynab.createTransaction('b', { accountId: 'chk', transferAccountId: 'sav', payeeName: 'X', date: '2026-09-30', amount: -1 }), /not both/);
await assert.rejects(ynab.createTransaction('b', { accountId: 'chk', transferAccountId: 'chk', date: '2026-09-30', amount: -1 }), /same account/);
await assert.rejects(ynab.createTransaction('b', { accountId: 'chk', transferAccountId: 'sav', categoryId: 'c', date: '2026-09-30', amount: -1 }), /no category/);
assert.equal(writes().length, 0);

// on-budget -> off-budget with a category is fine
reset();
await ynab.createTransaction('b', { accountId: 'chk', transferAccountId: 'loan', categoryId: 'loan-cat', date: '2026-09-30', amount: -1 });
assert.deepEqual([writes()[0].body.transaction.payee_id, writes()[0].body.transaction.category_id], ['tp-loan', 'loan-cat']);

// converting via update_transaction: source account comes from the existing transaction
reset();
await ynab.updateTransaction('b', 't1', { transferAccountId: 'chk' });
assert.deepEqual(writes()[0].body.transaction, { payee_id: 'tp-chk', category_id: null });

// bulk with one transfer among normal entries: two reads total, not one per entry
reset();
await ynab.bulkUpdateTransactions('b', [
  { transactionId: 't1', approved: true },
  { transactionId: 't2', transferAccountId: 'sav' },
]);
assert.deepEqual(writes()[0].body.transactions, [
  { id: 't1', approved: true },
  { id: 't2', payee_id: 'tp-sav', category_id: null },
]);
assert.equal(calls.filter((c) => c.method === 'GET' && c.path !== '/v1/plans').length, 2);

// Scheduled transfers use the destination payee and update the same schedule.
reset();
await ynab.createScheduledTransaction('b', { accountId: 'chk', transferAccountId: 'sav', date: '2026-09-30', frequency: 'monthly', amountMilliunits: -2000 });
assert.deepEqual(writes()[0].body.scheduled_transaction, {
  account_id: 'chk', date: '2026-09-30', frequency: 'monthly', amount: -2000, payee_id: 'tp-sav', category_id: null,
});
reset();
await ynab.updateScheduledTransaction('b', 's1', { transferAccountId: 'sav' });
await ynab.updateScheduledTransaction('b', 's1', { transferAccountId: 'sav' });
assert.deepEqual(writes(), Array.from({ length: 2 }, () => ({
  method: 'PUT', path: '/scheduled_transactions/s1', body: { scheduled_transaction: { payee_id: 'tp-sav', category_id: null } },
})));

console.log('transfer checks passed');
