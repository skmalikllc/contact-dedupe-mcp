/**
 * Contact matching + deduplication core.
 *
 * Deliberately free of MCP/protocol code so the matching rules can be tested
 * on their own (see test/dedupe.test.js).
 */

/* ---------- normalisation ---------- */

const normSpace = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Lowercase, strip accents and punctuation — for name comparison only. */
function normName(s) {
  return normSpace(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')       // O'Neil -> oneil, not "o neil"
    .replace(/[.,;:/\\_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Gmail treats dots and +tags as noise; most other hosts do not.
 * Keeping that distinction avoids merging two genuinely different people.
 */
function normEmail(s) {
  const raw = normSpace(s).toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at < 1) return raw;
  let local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}

/**
 * Keep the last `keep` digits so +92 300 1234567, 0300-1234567 and
 * 00923001234567 compare equal without guessing the country.
 */
function normPhone(s, keep = 9) {
  const digits = String(s == null ? '' : s).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length <= keep ? digits : digits.slice(-keep);
}

/* ---------- similarity ---------- */

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity. */
function ratio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / max;
}

/** Same words in any order counts as a match: "Ali Raza" vs "Raza, Ali". */
function nameSimilarity(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const sa = na.split(' ').filter(Boolean).sort().join(' ');
  const sb = nb.split(' ').filter(Boolean).sort().join(' ');
  return Math.max(ratio(na, nb), ratio(sa, sb));
}

/* ---------- record scoring ---------- */

const DEFAULT_FIELDS = { name: 'name', email: 'email', phone: 'phone', company: 'company' };

/**
 * Score a pair of records 0..1 and explain which signals fired.
 * Exact email or exact phone is treated as strong evidence; names alone are not.
 */
function scorePair(a, b, fields = DEFAULT_FIELDS) {
  const reasons = [];
  let score = 0;

  const ea = normEmail(a[fields.email]);
  const eb = normEmail(b[fields.email]);
  if (ea && eb) {
    if (ea === eb) { score = Math.max(score, 0.95); reasons.push('same email'); }
    else if (ratio(ea, eb) > 0.9) { score = Math.max(score, 0.6); reasons.push('near-identical email'); }
  }

  const pa = normPhone(a[fields.phone]);
  const pb = normPhone(b[fields.phone]);
  if (pa && pb && pa === pb) { score = Math.max(score, 0.9); reasons.push('same phone'); }

  const ns = nameSimilarity(a[fields.name], b[fields.name]);
  if (ns >= 0.99) { score = Math.max(score, 0.6); reasons.push('same name'); }
  else if (ns >= 0.85) { score = Math.max(score, 0.45); reasons.push(`similar name (${ns.toFixed(2)})`); }

  const ca = normName(a[fields.company]);
  const cb = normName(b[fields.company]);
  if (ca && cb && ca === cb && ns >= 0.85) { score = Math.min(1, score + 0.2); reasons.push('same company'); }

  // Name + any one strong identifier is a confident match.
  if (ns >= 0.85 && (reasons.includes('same email') || reasons.includes('same phone'))) score = Math.max(score, 0.98);

  return { score: Math.min(1, score), reasons };
}

/* ---------- grouping ---------- */

/**
 * Block by cheap keys first (email, phone, first token of the name) so the
 * comparison stays near-linear instead of comparing every pair.
 */
function candidatePairs(rows, fields = DEFAULT_FIELDS) {
  const buckets = new Map();
  const add = (key, i) => {
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  };
  rows.forEach((r, i) => {
    add(`e:${normEmail(r[fields.email])}`, i);
    add(`p:${normPhone(r[fields.phone])}`, i);
    const n = normName(r[fields.name]);
    if (n) {
      add(`n:${n.split(' ')[0]}`, i);
      add(`n:${n.split(' ').slice(-1)[0]}`, i);
    }
  });
  const pairs = new Set();
  for (const idxs of buckets.values()) {
    if (idxs.length < 2 || idxs.length > 400) continue;
    for (let i = 0; i < idxs.length; i += 1) {
      for (let j = i + 1; j < idxs.length; j += 1) {
        pairs.add(idxs[i] < idxs[j] ? `${idxs[i]},${idxs[j]}` : `${idxs[j]},${idxs[i]}`);
      }
    }
  }
  return [...pairs].map((s) => s.split(',').map(Number));
}

/** Union-find over pairs above the threshold → duplicate groups. */
function findDuplicates(rows, { fields = DEFAULT_FIELDS, threshold = 0.85 } = {}) {
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { const a = find(i); const b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };

  const evidence = [];
  for (const [i, j] of candidatePairs(rows, fields)) {
    const { score, reasons } = scorePair(rows[i], rows[j], fields);
    if (score >= threshold) { union(i, j); evidence.push({ a: i, b: j, score: Number(score.toFixed(2)), reasons }); }
  }

  const groups = new Map();
  rows.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });

  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((indexes) => ({
      indexes,
      records: indexes.map((i) => rows[i]),
      evidence: evidence.filter((e) => indexes.includes(e.a) && indexes.includes(e.b)),
    }));
}

/* ---------- merging ---------- */

const filled = (v) => String(v == null ? '' : v).trim() !== '';

/**
 * Merge a group into one record: the most complete record wins as the base,
 * blanks are filled from the others, and every value that disagrees is
 * reported as a conflict rather than silently dropped.
 */
function mergeGroup(records, { preferLongest = true } = {}) {
  const completeness = (r) => Object.values(r).filter(filled).length;
  const ordered = [...records].sort((a, b) => completeness(b) - completeness(a));
  const base = { ...ordered[0] };
  const conflicts = [];

  for (const rec of ordered.slice(1)) {
    for (const [k, v] of Object.entries(rec)) {
      if (!filled(v)) continue;
      if (!filled(base[k])) { base[k] = v; continue; }
      const same = normSpace(base[k]).toLowerCase() === normSpace(v).toLowerCase();
      if (same) continue;
      if (preferLongest && String(v).length > String(base[k]).length && normSpace(String(v).toLowerCase()).includes(normSpace(String(base[k]).toLowerCase()))) {
        conflicts.push({ field: k, kept: v, dropped: base[k], note: 'kept the longer value that contains the shorter one' });
        base[k] = v;
      } else {
        conflicts.push({ field: k, kept: base[k], dropped: v });
      }
    }
  }
  return { merged: base, conflicts };
}

/** Full pass: returns the surviving rows plus a report of what happened. */
function dedupe(rows, opts = {}) {
  const groups = findDuplicates(rows, opts);
  const claimed = new Set();
  const output = [];
  const report = [];

  groups.forEach((g, gi) => {
    const { merged, conflicts } = mergeGroup(g.records, opts);
    g.indexes.forEach((i) => claimed.add(i));
    output.push(merged);
    report.push({
      group: gi + 1,
      rows: g.indexes.map((i) => i + 1),
      kept: merged,
      evidence: g.evidence,
      conflicts,
    });
  });

  rows.forEach((r, i) => { if (!claimed.has(i)) output.push(r); });

  return {
    input: rows.length,
    output: output.length,
    removed: rows.length - output.length,
    rows: output,
    groups: report,
  };
}

module.exports = {
  normName, normEmail, normPhone, nameSimilarity, ratio, levenshtein,
  scorePair, candidatePairs, findDuplicates, mergeGroup, dedupe,
};
