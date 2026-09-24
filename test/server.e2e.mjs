/**
 * End-to-end check: start the server over stdio exactly as an MCP client would,
 * list the tools, and run the three-step flow on sample/contacts.csv.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'src', 'server.mjs')],
});
const client = new Client({ name: 'e2e', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
assert.deepStrictEqual(
  tools.map((t) => t.name).sort(),
  ['compare_records', 'dedupe_csv', 'find_duplicates', 'profile_csv']
);

const csv = path.join(root, 'sample', 'contacts.csv');
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const profile = await call('profile_csv', { file: csv });
console.log('\nprofile_csv →', { rows: profile.rows, detected: profile.detected_fields });
assert.strictEqual(profile.detected_fields.email, 'Email');
assert.strictEqual(profile.detected_fields.phone, 'Mobile');

const dupes = await call('find_duplicates', { file: csv });
console.log('duplicate groups:', dupes.duplicate_groups, '| rows involved:', dupes.rows_involved);
dupes.groups.forEach((g) => console.log(`  group ${g.group}: rows ${g.rows.join(', ')} — ${g.evidence.map((e) => e.reasons.join(' + ')).join(' ; ')}`));
assert.ok(dupes.duplicate_groups >= 3);

const run = await call('dedupe_csv', { file: csv, dry_run: true });
console.log('\ndedupe_csv (dry run) →', { input: run.input_rows, output: run.output_rows, removed: run.removed });
console.log('conflicts flagged:', run.conflicts.map((c) => `${c.field}: kept "${c.kept}" / dropped "${c.dropped}"`).join(' | ') || 'none');
assert.ok(run.removed >= 3);
assert.strictEqual(run.written, null);

const pair = await call('compare_records', {
  a: { name: 'Ali Raza', email: 'ali.raza@gmail.com', phone: '' },
  b: { name: 'Raza, Ali', email: 'aliraza@gmail.com', phone: '' },
});
console.log('\ncompare_records →', pair);
assert.strictEqual(pair.verdict, 'duplicate');

await client.close();
console.log('\nE2E OK');
