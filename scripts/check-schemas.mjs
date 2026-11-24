#!/usr/bin/env node
// Regression check on the *advertised* tool surface: what tools/list returns to
// a client, not what the handlers happen to accept. A handler can read an
// argument the schema never declares (zod would strip it, or a strict client
// would refuse to send it), so the transfer feature must be visible here.
// Usage: node --experimental-strip-types --no-warnings --import ./scripts/ts-resolve.mjs scripts/check-schemas.mjs
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { YnabService } from '../src/ynab.ts';
import { registerTools } from '../src/tools.ts';

async function connectClient(allowWrites) {
  const server = new McpServer({ name: 'schema-check', version: '0' });
  registerTools(server, new YnabService({ YNAB_ACCESS_TOKEN: 'x', YNAB_ALLOW_WRITES: String(allowWrites) }), allowWrites);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-check', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function listTools(allowWrites) {
  const client = await connectClient(allowWrites);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(tools.map((t) => [t.name, t]));
}

const tools = await listTools(true);
const tool = (name) => tools.get(name) ?? assert.fail(`${name} is not advertised`);

// Every transaction write tool advertises transfer_account_id and mentions transfers.
const props = {
  create_transaction: (t) => t.inputSchema.properties,
  update_transaction: (t) => t.inputSchema.properties,
  bulk_update_transactions: (t) => t.inputSchema.properties.updates.items.properties,
  create_scheduled_transaction: (t) => t.inputSchema.properties,
  update_scheduled_transaction: (t) => t.inputSchema.properties,
};
for (const [name, pick] of Object.entries(props)) {
  const t = tool(name);
  const p = pick(t);
  assert.ok(p.transfer_account_id, `${name}: transfer_account_id missing from the advertised inputSchema`);
  assert.equal(p.transfer_account_id.type, 'string', `${name}: transfer_account_id should be a string`);
  assert.match(p.transfer_account_id.description ?? '', /payee_name/, `${name}: description should say not to combine with payee_name`);
  assert.ok(p.payee_name, `${name}: payee_name should still be advertised`);
  assert.match(t.description, /transfer/i, `${name}: tool description should mention transfers`);
}

// Converting an existing transaction creates the counterpart, so warn about an already-imported duplicate.
assert.match(tool('update_transaction').description, /already imported/);
for (const [create, list] of [
  ['create_transaction', 'list_transactions'],
  ['create_scheduled_transaction', 'list_scheduled_transactions'],
]) {
  assert.match(tool(create).description, new RegExp(`check ${list}.*before retrying`));
  assert.equal(tool(create).annotations.idempotentHint, false);
}
const createDescription = tool('create_transaction').description;
assert.match(createDescription, /since_date and until_date to the original transaction date/);
assert.match(createDescription, /offset.*while has_more is true/);
assert.match(createDescription, /Retry only if you can confirm the original was not saved/);
// Deleting one side of a transfer deletes both.
assert.match(tool('delete_transaction').description, /transfer deletes both/);
// The update tools have no account_id of their own, so their descriptions must not tell the model to set one.
for (const name of ['update_transaction', 'bulk_update_transactions']) {
  assert.ok(!tool(name).inputSchema.properties.account_id, `${name} unexpectedly takes account_id`);
  assert.doesNotMatch(tool(name).description, /set account_id/, `${name}: description tells the model to set an account_id it cannot pass`);
}

// Read responses expose the ids needed to build and recognise transfers.
assert.match(tool('list_accounts').description, /transfer/i, 'list_accounts should mention transfer_payee_id / transfers');
assert.match(tool('list_transactions').description, /transfer/i, 'list_transactions should mention transfer fields');
// Long histories can be paged: offset and until_date are advertised, and the description says how.
for (const p of ['offset', 'until_date']) {
  assert.ok(tool('list_transactions').inputSchema.properties[p], `list_transactions: ${p} missing from the advertised inputSchema`);
}
assert.match(tool('list_transactions').description, /has_more/, 'list_transactions should explain how to page');

// Payee merging is advertised, and update_payee no longer claims a rename merges.
assert.ok(tool('merge_payees').inputSchema.properties.merges.items.properties.source_payee_ids, 'merge_payees schema');
assert.doesNotMatch(tool('update_payee').description, /effectively merges/);
assert.ok(tool('list_payees').inputSchema.properties.query, 'list_payees query filter');

// A read-only deployment advertises none of the write tools.
const readOnly = await listTools(false);
for (const name of [...Object.keys(props), 'merge_payees', 'create_payee']) assert.ok(!readOnly.has(name), `${name} advertised without writes enabled`);

// Exercise the new routes through tools/call, including the optional route selectors.
const payee = { id: 'p', name: 'Bakery', transfer_account_id: null };
const location = { id: 'l', payee_id: 'p', latitude: '34', longitude: '-118', deleted: false };
const movement = { id: 'm', amount: 1250, from_category_id: 'c', to_category_id: 'd' };
const group = { id: 'g', month: '2026-10-01', group_created_at: '2026-10-02T00:00:00Z' };
const transaction = { id: 't', amount: -1250, date: '2026-10-02', deleted: false };
const budget = '/v1/plans/b';
const month = budget + '/months/2026-10-01';
const routes = new Map([
  ['GET /v1/plans', { plans: [] }],
  ['GET ' + budget, { plan: { id: 'b', name: 'Test', accounts: [{}] }, server_knowledge: 2 }],
  ['GET ' + budget + '/accounts/a', { account: { id: 'a', balance: 1000, cleared_balance: 1000, uncleared_balance: 0 } }],
  ['GET ' + budget + '/categories/c', { category: { id: 'c', budgeted: 2000, activity: -750, balance: 1250 } }],
  ['GET ' + budget + '/payees/p', { payee }],
  ['POST ' + budget + '/payees', { payee, server_knowledge: 3 }],
  ['GET ' + budget + '/payee_locations', { payee_locations: [location] }],
  ['GET ' + budget + '/payee_locations/l', { payee_location: location }],
  ['GET ' + budget + '/payees/p/payee_locations', { payee_locations: [location] }],
  ['GET ' + budget + '/money_movements', { money_movements: [movement, { ...movement, id: 'm2' }], server_knowledge: 4 }],
  ['GET ' + month + '/money_movements', { money_movements: [movement], server_knowledge: 4 }],
  ['GET ' + budget + '/money_movement_groups', { money_movement_groups: [group], server_knowledge: 4 }],
  ['GET ' + month + '/money_movement_groups', { money_movement_groups: [group], server_knowledge: 4 }],
  ['GET ' + month + '/transactions', { transactions: [transaction] }],
]);

const calls = [];
globalThis.fetch = async (url, init) => {
  const request = new URL(url);
  const route = `${init.method} ${request.pathname}`;
  assert.ok(routes.has(route), `unexpected request ${route}`);
  calls.push({ route, query: Object.fromEntries(request.searchParams), body: init.body });
  return Response.json({ data: routes.get(route) });
};

const reader = await connectClient(false);
const writer = await connectClient(true);
async function call(name, args = {}, client = reader) {
  const result = await client.callTool({ name, arguments: { budget_id: 'b', ...args } });
  assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}
try {
  const details = await call('get_budget');
  assert.equal(details.accounts, 1);
  assert.equal(details.server_knowledge, 2);
  assert.equal((await call('get_account', { account_id: 'a' })).balance, '$1.00');
  assert.equal((await call('get_category', { category_id: 'c' })).balance, '$1.25');
  assert.deepEqual(await call('get_payee', { payee_id: 'p' }), payee);
  assert.deepEqual(await call('get_payee_location', { payee_location_id: 'l' }), location);
  assert.deepEqual((await call('list_payee_locations')).payee_locations, [location]);
  assert.deepEqual((await call('list_payee_locations', { payee_id: 'p' })).payee_locations, [location]);

  const movements = await call('list_money_movements', { limit: 1 });
  assert.equal(movements.has_more, true);
  assert.equal(movements.money_movements[0].amount_currency, 1.25);
  const secondPage = await call('list_money_movements', { limit: 1, offset: 1 });
  assert.equal(secondPage.has_more, false);
  assert.equal(secondPage.money_movements[0].id, 'm2');
  assert.equal((await call('list_money_movements', { month: '2026-10' })).returned, 1);
  assert.deepEqual((await call('list_money_movement_groups')).money_movement_groups, [group]);
  assert.deepEqual((await call('list_money_movement_groups', { month: '2026-10' })).money_movement_groups, [group]);

  const transactions = await call('list_transactions', { month: '2026-10', until_date: '2026-10-02' });
  assert.equal(transactions.transactions[0].id, 't');
  assert.deepEqual(calls.at(-1).query, { until_date: '2026-10-02' });
  const beforeInvalid = calls.length;
  const invalid = await reader.callTool({
    name: 'list_transactions', arguments: { budget_id: 'b', month: '2026-10', account_id: 'a' },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /use since_date and until_date/);
  assert.equal(calls.length, beforeInvalid);

  assert.deepEqual(await call('create_payee', { name: ' Bakery ' }, writer), {
    created: true, id: 'p', name: 'Bakery',
  });
  assert.deepEqual(JSON.parse(calls.at(-1).body), { payee: { name: 'Bakery' } });
  assert.equal(tool('create_payee').annotations.idempotentHint, false);
  assert.deepEqual(new Set(calls.map(({ route }) => route)), new Set(routes.keys()));
} finally {
  await Promise.all([reader.close(), writer.close()]);
}

console.log(`schema checks passed (${tools.size} tools advertised with writes, ${readOnly.size} read-only)`);
