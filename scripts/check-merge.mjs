#!/usr/bin/env node
// Offline checks for merge_payees, with fetch mocked.
// Usage: node --experimental-strip-types --no-warnings scripts/check-merge.mjs
import assert from 'node:assert/strict';
import { YnabService, splitNote, mergeMemo } from '../src/ynab.ts';

// ---- helpers
assert.deepEqual(splitNote('Caro Thurin "korean bbq :)"'), { base: 'Caro Thurin', note: 'korean bbq :)' });
assert.deepEqual(splitNote('Nijiya Market'), { base: 'Nijiya Market' });
assert.equal(mergeMemo('', 'tacos'), 'tacos');
assert.equal(mergeMemo('split w/ D', 'tacos'), 'split w/ D · tacos');
assert.equal(mergeMemo('already tacos here', 'tacos'), undefined);
assert.equal(mergeMemo('anything', undefined), undefined);

// ---- fixture
const PAYEES = [
  { id: 'p-caro', name: 'Caro', deleted: false },
  { id: 'p-bbq', name: 'Caro Thurin "korean bbq"', deleted: false },
  { id: 'p-sushi', name: 'Caro Thurin "🍣"', deleted: false },
  { id: 'p-ten', name: '10 Speed Coffee', deleted: false },
  { id: 'p-tst', name: 'TST* 10 SPEED - SAWTEL', deleted: false },
  { id: 'p-xfer', name: 'Transfer : Savings', deleted: false, transfer_account_id: 'a-sav' },
];
const TXNS = [
  { id: 't1', payee_id: 'p-bbq', memo: null, deleted: false },
  { id: 't2', payee_id: 'p-bbq', memo: 'with Diego', deleted: false },
  { id: 't3', payee_id: 'p-caro', memo: '', deleted: false },
  { id: 't4', payee_id: 'p-tst', memo: null, deleted: false },
  { id: 't5', payee_id: 'p-sushi', memo: null, deleted: true },
  { id: 't6', payee_id: null, memo: null, deleted: false, subtransactions: [{ id: 's1', payee_id: 'p-tst', deleted: false }] },
];
const SCHED = [
  { id: 'sch1', payee_id: 'p-caro', account_id: 'a-chk', date_next: '2026-11-01', amount: -65000, frequency: 'monthly',
    category_id: 'c-food', memo: null, flag_color: null, deleted: false },
  { id: 'sch2', payee_id: 'p-bbq', account_id: 'a-chk', date_next: '2026-11-15', amount: -20000, frequency: 'monthly',
    category_id: 'c-eat', memo: null, flag_color: 'red', deleted: false },
];

let calls;
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname.replace('/v1/plans/b', '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method, path, body });
  const data =
    path === '/payees' ? { payees: PAYEES }
    : path === '/transactions' && init.method === 'GET' ? { transactions: TXNS }
    : path === '/scheduled_transactions' && init.method === 'GET' ? { scheduled_transactions: SCHED }
    : path.startsWith('/payees/') ? { payee: { id: path.slice(8), name: body.payee.name } }
    : path === '/transactions' ? { transaction_ids: body.transactions.map((t) => t.id), transactions: [] }
    : path.startsWith('/scheduled_transactions/') ? { scheduled_transaction: body.scheduled_transaction }
    : assert.fail(`unexpected ${init.method} ${path}`);
  return new Response(JSON.stringify({ data }));
};
const ynab = new YnabService({ YNAB_ACCESS_TOKEN: 'x', YNAB_ALLOW_WRITES: 'true' });
const writes = () => calls.filter((c) => c.method !== 'GET');
const merges = [
  // no payee is named "Caro Thurin" yet, so "Caro" (the one without a note) gets renamed into it
  { targetName: 'Caro Thurin', sourcePayeeIds: ['p-caro', 'p-bbq', 'p-sushi'] },
  // target exists and is also listed as a source: it is kept, not moved onto itself
  { targetName: '10 Speed Coffee', sourcePayeeIds: ['p-tst', 'p-ten'] },
];

// dry run: nothing written, counts reported
calls = [];
const dry = await ynab.mergePayees('b', merges, { noteToMemo: true, dryRun: true });
assert.equal(writes().length, 0);
assert.equal(dry.merges[0].created_by_renaming, 'Caro');
assert.deepEqual(dry.merges[0].merged_payees, ['Caro Thurin "korean bbq"', 'Caro Thurin "🍣"']);
assert.equal(dry.merges[1].split_lines_skipped, 1);
assert.equal(calls.length, 3, 'one read each of payees, transactions, scheduled');

// real run
calls = [];
await ynab.mergePayees('b', merges, { noteToMemo: true, dryRun: false });
const [rename, patch, put, ...rest] = writes();
assert.equal(rest.length, 0, 'one rename, one bulk patch, one scheduled put');
assert.deepEqual([rename.path, rename.body], ['/payees/p-caro', { payee: { name: 'Caro Thurin' } }]);
assert.deepEqual(patch.body.transactions, [
  { id: 't1', payee_id: 'p-caro', memo: 'korean bbq' },
  { id: 't2', payee_id: 'p-caro', memo: 'with Diego · korean bbq' },
  { id: 't4', payee_id: 'p-ten' },
]); // t3 is already on the target; t5 is deleted; the split line is left alone
// sch1 is already on the renamed target; sch2 moves and keeps its note
assert.deepEqual([put.method, put.path, put.body.scheduled_transaction], ['PUT', '/scheduled_transactions/sch2', {
  account_id: 'a-chk', date: '2026-11-15', amount: -20000, frequency: 'monthly', payee_id: 'p-caro',
  category_id: 'c-eat', memo: 'korean bbq', flag_color: 'red',
}]);

// guards
calls = [];
await assert.rejects(ynab.mergePayees('b', [{ targetName: 'X', sourcePayeeIds: ['p-xfer'] }], { noteToMemo: true, dryRun: true }), /transfer payee/);
await assert.rejects(ynab.mergePayees('b', [{ targetName: 'X', sourcePayeeIds: ['nope'] }], { noteToMemo: true, dryRun: true }), /not found/);
await assert.rejects(
  ynab.mergePayees('b', [{ targetName: 'A', sourcePayeeIds: ['p-tst'] }, { targetName: 'B', sourcePayeeIds: ['p-tst'] }], { noteToMemo: true, dryRun: true }),
  /more than one merge/,
);
const ro = new YnabService({ YNAB_ACCESS_TOKEN: 'x', YNAB_ALLOW_WRITES: 'false' });
await assert.rejects(ro.mergePayees('b', merges, { noteToMemo: true, dryRun: false }), /read-only/);

console.log('merge checks passed');
