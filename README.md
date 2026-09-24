# contact-dedupe — MCP server

An MCP (Model Context Protocol) server that lets Claude, or any MCP client,
work on a contact export: profile it, find the rows that are the same person,
and write a merged file — with every conflicting value reported instead of
quietly dropped.

Built for the job I get asked for most often: a CRM or Google Contacts export
where the same person appears three times as `Ali Raza`, `Raza, Ali` and
`Ali R.`, with the phone number on one row and the email on another.

## Tools

| Tool | What it does |
|---|---|
| `profile_csv` | rows, columns, fill rate per column, and the detected name/email/phone/company mapping |
| `find_duplicates` | duplicate groups with the evidence behind each match — read-only |
| `dedupe_csv` | merges each group into one row, writes a cleaned CSV (`dry_run` supported) |
| `compare_records` | scores a single pair 0–1 and lists the signals, for tuning the threshold |

## Matching rules

Exact-match dedupe misses most real duplicates, and fuzzy name matching alone
merges people who merely share a surname. So the score comes from several
signals:

- **Email** — `Ali.Raza+crm@gmail.com` and `aliraza@gmail.com` are the same
  mailbox, but `a.b@outlook.com` and `ab@outlook.com` are **not**; the dot rule
  is a Gmail behaviour, not a general one.
- **Phone** — compared on the last 9 digits, so `+92 300 1234567`,
  `0300-1234567` and `00923001234567` line up without guessing a country.
- **Name** — accent- and punctuation-insensitive, order-insensitive
  (`Raza, Ali` = `Ali Raza`), Levenshtein for the rest.
- **Company** — only ever a tie-breaker on top of a name match.

A shared email or phone is strong evidence; a similar name on its own is not
enough to merge. Groups form transitively (A–B by phone, B–C by email puts all
three together), and the threshold is a parameter, not a hard-coded constant.

Merging keeps the most complete row as the base, fills blanks from the others,
prefers the longer value when one contains the other (`Beta Foods` →
`Beta Foods Pvt Ltd`), and reports everything else as a conflict.

## Install

```bash
npm install
```

Register it with an MCP client (Claude Desktop / Claude Code):

```json
{
  "mcpServers": {
    "contact-dedupe": {
      "command": "node",
      "args": ["/absolute/path/to/csv-dedupe-mcp/src/server.mjs"]
    }
  }
}
```

## Try it

```bash
node test/server.e2e.mjs
```

Runs the real stdio protocol against `sample/contacts.csv` (10 rows, messy on
purpose) and prints:

```
duplicate groups: 3 | rows involved: 7
  group 1: rows 2, 3, 4 — same email + same name + same company ; same phone
  group 2: rows 5, 6 — same email + same name
  group 3: rows 8, 9 — same email
dedupe_csv (dry run) → { input: 10, output: 6, removed: 4 }
conflicts flagged: Company: kept "Beta Foods Pvt Ltd" / dropped "Beta Foods" | …
```

## Tests

```bash
node --test test/dedupe.test.js   # 9 tests: normalisation, scoring, grouping, merge, CSV
node test/server.e2e.mjs          # protocol-level run over stdio
```

## Layout

```
src/server.mjs   MCP server (stdio) — tool definitions and zod schemas
src/dedupe.js    matching, grouping and merge logic (no protocol code)
src/csv.js       RFC 4180 CSV reader/writer, no dependencies
sample/          messy sample export
test/            unit tests + end-to-end MCP client test
```

The matching logic holds no MCP code on purpose — the rules that decide whether
two people are the same are the part worth testing on their own.
