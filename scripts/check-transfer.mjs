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
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname.replace('/v1/plans/b', '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path, body });
  const echo = (t) => ({ id: 't', date: '2026-09-30', amount: 0, cleared: 'uncleared', approved: true,
    account_name: 'x', deleted: false, ...t, transfer_account_id: t.payee_id?.slice(3), transfer_transaction_id: 'tt' });
  const data =
    path === '/v1/plans' ? { plans: [] }
    : path === '/accounts' ? { accounts: ACCOUNTS }
    : path === '/transactions' && init.method === 'GET' ? { transactions: TXNS }
    : path.startsWith('/transactions/') && init.method === 'GET' ? { transaction: TXNS.find((t) => path.endsWith(t.id)) }
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

console.log('transfer checks passed');
