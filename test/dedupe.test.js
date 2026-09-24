const assert = require('node:assert');
const test = require('node:test');
const { normEmail, normPhone, nameSimilarity, scorePair, findDuplicates, mergeGroup, dedupe } = require('../src/dedupe.js');
const { toObjects, fromObjects, parseCsv } = require('../src/csv.js');

test('gmail dots and +tags normalise, other hosts keep dots', () => {
  assert.strictEqual(normEmail('Ali.Raza+news@gmail.com'), 'aliraza@gmail.com');
  assert.strictEqual(normEmail('ali.raza@company.com'), 'ali.raza@company.com');
  assert.notStrictEqual(normEmail('a.b@outlook.com'), normEmail('ab@outlook.com'));
});

test('phone formats collapse to the same national digits', () => {
  assert.strictEqual(normPhone('+92 300 1234567'), normPhone('0300-1234567'));
  assert.strictEqual(normPhone('0092 300 1234567'), normPhone('3001234567'));
  assert.strictEqual(normPhone(''), '');
});

test('name similarity handles reordering and punctuation', () => {
  assert.ok(nameSimilarity('Ali Raza', 'Raza, Ali') > 0.95);
  assert.ok(nameSimilarity("Sarah O'Neil", 'Sarah ONeil') > 0.95);
  assert.ok(nameSimilarity('Ali Raza', 'Bilal Khan') < 0.5);
});

test('same email scores as a duplicate, same surname alone does not', () => {
  const a = { name: 'Ali Raza', email: 'ali@x.com', phone: '', company: '' };
  const b = { name: 'A. Raza', email: 'ali@x.com', phone: '', company: '' };
  assert.ok(scorePair(a, b).score >= 0.9);

  const c = { name: 'Ali Raza', email: 'ali@x.com', phone: '', company: '' };
  const d = { name: 'Sana Raza', email: 'sana@x.com', phone: '', company: '' };
  assert.ok(scorePair(c, d).score < 0.85);
});

test('groups form across transitive matches', () => {
  const rows = [
    { name: 'Ali Raza', email: 'ali@x.com', phone: '0300 1234567', company: 'Acme' },
    { name: 'Raza, Ali', email: '', phone: '+92 300 1234567', company: 'Acme' },
    { name: 'Ali R.', email: 'ali@x.com', phone: '', company: '' },
    { name: 'Bilal Khan', email: 'bilal@y.com', phone: '0321 7654321', company: 'Beta' },
  ];
  const groups = findDuplicates(rows);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].indexes, [0, 1, 2]);
});

test('merge fills blanks and reports real conflicts', () => {
  const { merged, conflicts } = mergeGroup([
    { name: 'Ali Raza', email: 'ali@x.com', phone: '', city: 'Lahore' },
    { name: 'Ali Raza', email: 'ali@x.com', phone: '03001234567', city: 'Karachi' },
  ]);
  assert.strictEqual(merged.phone, '03001234567');
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].field, 'city');
});

test('full dedupe keeps unmatched rows untouched', () => {
  const rows = [
    { name: 'Ali Raza', email: 'ali@x.com', phone: '' },
    { name: 'Ali Raza', email: 'ali@x.com', phone: '0300 1234567' },
    { name: 'Bilal Khan', email: 'bilal@y.com', phone: '' },
  ];
  const res = dedupe(rows);
  assert.strictEqual(res.input, 3);
  assert.strictEqual(res.output, 2);
  assert.strictEqual(res.removed, 1);
  assert.ok(res.rows.some((r) => r.name === 'Bilal Khan'));
});

test('csv round-trips quotes, commas and newlines', () => {
  const csv = 'name,note\r\n"Raza, Ali","said ""hi"""\r\n"multi\nline",ok';
  const { headers, records } = toObjects(csv);
  assert.deepStrictEqual(headers, ['name', 'note']);
  assert.strictEqual(records[0].name, 'Raza, Ali');
  assert.strictEqual(records[0].note, 'said "hi"');
  assert.strictEqual(records[1].name, 'multi\nline');
  const again = toObjects(fromObjects(records, headers));
  assert.deepStrictEqual(again.records, records);
});

test('parseCsv drops fully blank lines', () => {
  assert.strictEqual(parseCsv('a,b\r\n1,2\r\n\r\n3,4\r\n').length, 3);
});
