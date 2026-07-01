// =============================================================================
//  SPELL CONFIG  —  the ONE place to edit trigger words / names.
//
//  NOTE: the spell names below are Harry Potter terms (Warner Bros. IP), fine
//  for a personal/portfolio build. To ship commercially, just swap the
//  `label` and `keywords` here for generic words — nothing else needs editing.
//
//  Matching (see matchCommand below) is deliberately forgiving: speech engines
//  mangle made-up spell names, so we accept exact words, prefixes ("incen" →
//  incendio), small typos/fuzzy hits ("defendo" → diffindo), and multi-word
//  mishearings ("in send io" → incendio). Add any new mishears you see in the
//  voice debug panel (press V) straight into the keyword lists.
// =============================================================================

// type → behaviour is implemented in src/spells/effects/*. Keywords are matched
// case-insensitively. Multi-word entries match a run of consecutive words.
export const SPELLS = [
  {
    type: 'fire',
    label: 'Incendio',
    keywords: [
      'incendio', 'incendia', 'incendiary', 'incendi', 'incen', 'encinto',
      'in send io', 'send io', 'in scene', 'in you', 'in cd o', 'sin dio',
      'fire', 'ignite', 'flame', 'burn',
    ],
  },
  {
    type: 'force',
    label: 'Depulso',
    keywords: [
      'depulso', 'depulse', 'repulso', 'impulso', 'the pulse', 'de pulse',
      'disposal', 'desposal', 'disposable', 'the pool', 'deep pulse',
      'expelliarmus', 'force', 'push', 'blast', 'repulse',
    ],
  },
  {
    type: 'light',
    label: 'Lumos',
    keywords: ['lumos', 'loomos', 'luminous', 'light', 'illuminate'],
    toggle: true, // turns the orb on; say it again (or "Nox") to turn off
  },
  {
    type: 'lightoff',
    label: 'Nox',
    keywords: ['nox', 'knox', 'knocks', 'knock', 'dark', 'darkness'],
  },
  {
    type: 'slash',
    label: 'Diffindo',
    keywords: [
      'diffindo', 'defendo', 'difindo', 'definido', 'diffin', 'the fin',
      'slash', 'cut', 'sever', 'slice', 'divide',
    ],
  },
];

// Words that summon the wand.
export const WAND_KEYWORDS = [
  'wand', 'wond', 'want', 'wanda', 'wander', 'wanned', 'bond', 'band', 'bonds', 'bands',
];

// --- Build lookup tables: single words vs multi-word phrases ------------------
const SINGLE = []; // { word, target }
const PHRASE = []; // { parts: [...], target }

function addKeyword(k, target) {
  if (k.includes(' ')) PHRASE.push({ parts: k.split(' '), target });
  else SINGLE.push({ word: k, target });
}
for (const s of SPELLS) for (const k of s.keywords) addKeyword(k, { kind: 'spell', spell: s });
for (const k of WAND_KEYWORDS) addKeyword(k, { kind: 'wand' });

// Classic Levenshtein edit distance (small strings, so the simple DP is fine).
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Does a spoken word match a keyword? Exact, prefix, or a small fuzzy distance.
function wordMatches(word, key) {
  if (word === key) return true;
  // Prefix either way (recognizer often clips/extends made-up names): "incen"↔"incendio".
  if (word.length >= 4 && key.startsWith(word)) return true;
  if (key.length >= 4 && word.startsWith(key)) return true;
  // Fuzzy: allow ~1 edit per 3 characters, but only for longer words to avoid
  // false hits on short common ones ("cut", "dark").
  const maxLen = Math.max(word.length, key.length);
  if (maxLen >= 5 && levenshtein(word, key) <= Math.floor(maxLen / 3)) return true;
  return false;
}

// Scan a transcript for the most recent matching command. Returns
// { kind: 'wand' } | { kind: 'spell', spell } | null.
export function matchCommand(transcript) {
  const words = transcript
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length) return null;

  // Walk backwards so the most recently spoken command wins.
  for (let i = words.length - 1; i >= 0; i--) {
    // Single-word keywords (with prefix/fuzzy tolerance).
    for (const { word, target } of SINGLE) {
      if (wordMatches(words[i], word)) return target;
    }
    // Multi-word mishearings: match an exact run of words ending at i.
    for (const { parts, target } of PHRASE) {
      const start = i - parts.length + 1;
      if (start < 0) continue;
      let ok = true;
      for (let k = 0; k < parts.length; k++) {
        if (words[start + k] !== parts[k]) { ok = false; break; }
      }
      if (ok) return target;
    }
  }
  return null;
}
