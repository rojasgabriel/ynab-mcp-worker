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

async function listTools(allowWrites) {
  const server = new McpServer({ name: 'schema-check', version: '0' });
  registerTools(server, new YnabService({ YNAB_ACCESS_TOKEN: 'x', YNAB_ALLOW_WRITES: String(allowWrites) }), allowWrites);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-check', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
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

// Payee merging is advertised, and update_payee no longer claims a rename merges.
assert.ok(tool('merge_payees').inputSchema.properties.merges.items.properties.source_payee_ids, 'merge_payees schema');
assert.doesNotMatch(tool('update_payee').description, /effectively merges/);
assert.ok(tool('list_payees').inputSchema.properties.query, 'list_payees query filter');

// A read-only deployment advertises none of the write tools.
const readOnly = await listTools(false);
for (const name of [...Object.keys(props), 'merge_payees']) assert.ok(!readOnly.has(name), `${name} advertised without writes enabled`);

console.log(`schema checks passed (${tools.size} tools advertised with writes, ${readOnly.size} read-only)`);
