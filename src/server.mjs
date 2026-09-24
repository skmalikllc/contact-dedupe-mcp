#!/usr/bin/env node
/**
 * contact-dedupe MCP server (stdio).
 *
 * Gives an MCP client four tools for the job nobody enjoys doing by hand:
 * working out which rows in a contact export are the same person, and merging
 * them without quietly losing data.
 */
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const require = createRequire(import.meta.url);
const { toObjects, fromObjects } = require('./csv.js');
const { findDuplicates, dedupe, scorePair } = require('./dedupe.js');

const MAX_BYTES = 25 * 1024 * 1024;

const fieldsShape = {
  name: z.string().default('name'),
  email: z.string().default('email'),
  phone: z.string().default('phone'),
  company: z.string().default('company'),
};

async function loadCsv(file) {
  const abs = path.resolve(file);
  const text = await readFile(abs, 'utf8');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`File larger than ${MAX_BYTES} bytes`);
  const { headers, records } = toObjects(text);
  if (!records.length) throw new Error('No data rows found');
  return { abs, headers, records };
}

const text = (payload) => ({
  content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
});

/** Guess which column holds the name / email / phone, so callers rarely pass fields. */
function guessFields(headers, records) {
  const lower = headers.map((h) => h.toLowerCase());
  const pick = (...needles) => {
    for (const n of needles) {
      const i = lower.findIndex((h) => h.includes(n));
      if (i !== -1) return headers[i];
    }
    return '';
  };
  const guess = {
    name: pick('full name', 'name', 'contact'),
    email: pick('email', 'e-mail', 'mail'),
    phone: pick('phone', 'mobile', 'cell', 'tel'),
    company: pick('company', 'organization', 'organisation', 'account'),
  };
  // Fall back to content sniffing when the headers are unhelpful.
  if (!guess.email) {
    const col = headers.find((h) => records.some((r) => /@/.test(String(r[h] || ''))));
    if (col) guess.email = col;
  }
  return guess;
}

const server = new McpServer(
  { name: 'contact-dedupe', version: '1.0.0' },
  { instructions: 'Profile, match and deduplicate contact exports (CSV). Start with profile_csv to see the columns and the field mapping, then find_duplicates to review, then dedupe_csv to write the cleaned file.' }
);

server.registerTool(
  'profile_csv',
  {
    title: 'Profile a CSV',
    description: 'Row count, columns, fill rate per column and the detected name/email/phone/company mapping.',
    inputSchema: { file: z.string().describe('Path to the CSV file') },
  },
  async ({ file }) => {
    const { abs, headers, records } = await loadCsv(file);
    const fill = Object.fromEntries(
      headers.map((h) => {
        const n = records.filter((r) => String(r[h] ?? '').trim() !== '').length;
        return [h, `${n}/${records.length} (${Math.round((n / records.length) * 100)}%)`];
      })
    );
    return text({ file: abs, rows: records.length, columns: headers, fill_rate: fill, detected_fields: guessFields(headers, records) });
  }
);

server.registerTool(
  'find_duplicates',
  {
    title: 'Find duplicate groups',
    description: 'Group rows that look like the same person and explain why, without changing the file.',
    inputSchema: {
      file: z.string(),
      threshold: z.number().min(0).max(1).default(0.85).describe('0-1; lower finds more, with more false positives'),
      fields: z.object(fieldsShape).partial().optional(),
      limit: z.number().int().positive().default(50),
    },
  },
  async ({ file, threshold, fields, limit }) => {
    const { headers, records } = await loadCsv(file);
    const map = { ...guessFields(headers, records), ...(fields || {}) };
    const groups = findDuplicates(records, { fields: map, threshold });
    return text({
      rows: records.length,
      duplicate_groups: groups.length,
      rows_involved: groups.reduce((n, g) => n + g.indexes.length, 0),
      fields_used: map,
      groups: groups.slice(0, limit).map((g, i) => ({
        group: i + 1,
        rows: g.indexes.map((x) => x + 2), // +2 = 1-based with the header row
        evidence: g.evidence.map((e) => ({ score: e.score, reasons: e.reasons })),
        records: g.records,
      })),
    });
  }
);

server.registerTool(
  'dedupe_csv',
  {
    title: 'Deduplicate a CSV',
    description: 'Merge duplicate groups into one row each and write a cleaned CSV. Conflicting values are reported, never dropped silently.',
    inputSchema: {
      file: z.string(),
      out: z.string().optional().describe('Output path; defaults to <name>.deduped.csv'),
      threshold: z.number().min(0).max(1).default(0.85),
      fields: z.object(fieldsShape).partial().optional(),
      dry_run: z.boolean().default(false),
    },
  },
  async ({ file, out, threshold, fields, dry_run }) => {
    const { abs, headers, records } = await loadCsv(file);
    const map = { ...guessFields(headers, records), ...(fields || {}) };
    const result = dedupe(records, { fields: map, threshold });
    const target = out ? path.resolve(out) : abs.replace(/\.csv$/i, '') + '.deduped.csv';
    if (!dry_run) await writeFile(target, fromObjects(result.rows, headers), 'utf8');
    return text({
      input_rows: result.input,
      output_rows: result.output,
      removed: result.removed,
      written: dry_run ? null : target,
      dry_run,
      conflicts: result.groups.flatMap((g) => g.conflicts.map((c) => ({ group: g.group, ...c }))),
      groups: result.groups.map((g) => ({ group: g.group, rows: g.rows, kept: g.kept })),
    });
  }
);

server.registerTool(
  'compare_records',
  {
    title: 'Compare two records',
    description: 'Score a single pair 0-1 and list the signals behind the score — useful for tuning the threshold.',
    inputSchema: {
      a: z.record(z.string()).describe('First record as field/value pairs'),
      b: z.record(z.string()),
      fields: z.object(fieldsShape).partial().optional(),
    },
  },
  async ({ a, b, fields }) => {
    const map = { name: 'name', email: 'email', phone: 'phone', company: 'company', ...(fields || {}) };
    const { score, reasons } = scorePair(a, b, map);
    return text({ score: Number(score.toFixed(3)), reasons, verdict: score >= 0.85 ? 'duplicate' : score >= 0.6 ? 'needs review' : 'different' });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
