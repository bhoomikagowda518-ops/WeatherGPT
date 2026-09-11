const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const SEARCH_HEADERS = { 'User-Agent': 'WeatherGPT-RouteIntelligence/1.0' };
const CACHE_TTL = 10 * 60 * 1000;

const INDIA_COUNTRY = 'IN';
const INDIA_FIRST = true;

const searchCache = new Map();

/* Polite Nominatim gate: serialise every fetch so it never fires more than
   one request in any 800ms window. The public tier enforces ~1 req/s and
   returns HTTP 429 on violations. A gated sequence eliminates 429s entirely
   with no retry penalty — each request simply waits its turn.              */
let _reqGate = Promise.resolve();
function throttledFetch(url, options = {}) {
  const p = _reqGate.then(() => fetch(url, options));
  _reqGate = p.catch(() => {}).then(() => new Promise(r => setTimeout(r, 800)));
  return p;
}

/* =====================================================================
   Query normalization layer (alias + phonetic).
   A SMALL alias set for common Indian/Kannada place-name variants and
   imperfect speech-to-text misrecognitions (e.g. "Tumko" -> "Tumakuru").
   This is NOT a place database and it NEVER filters global search: it only
   rewrites a query token that otherwise produces no strong geocoder match
   into a spelling the geocoder reliably resolves. Every coordinate still
   comes from the real geocoder; nothing is invented here.
   ===================================================================== */

const PLACE_ALIASES = {
  'Tumakuru': ['tumko', 'tumakuar', 'tumakoor', 'tumakur', 'tumkur', 'tamkur', 'tamko', 'tumkoor', 'tumkure'],
  'Bengaluru': ['bangalore', 'bangluru', 'banglore', 'banglare', 'bangaluru', 'bengalur', 'bangloor', 'banglure', 'bengalore', 'bangl'],
  'Mysuru': ['mysore', 'mysoor', 'maysore', 'mysur', 'maysuru', 'maysor'],
  'Mangaluru': ['mangalore', 'manglore', 'mangalur', 'mangloore', 'mangloor'],
  'Hubballi': ['hubli', 'hubballi', 'hubali', 'hubbali', 'huball'],
  'Belagavi': ['belgaum', 'belagau', 'belagoom', 'belgavi', 'belgavu'],
  'Hassan': ['hasan', 'hassan'],
  'Shivamogga': ['shimoga', 'shivamoga', 'shimogga'],
  'Davanagere': ['davangere', 'davanager', 'davnagere'],
  'Kalaburagi': ['gulbarga', 'kalburgi', 'kalgiburg'],
  'Vijayapura': ['bijapur', 'vijapura', 'vijayapur'],
  'Ballari': ['bellary', 'ballary', 'belari'],
  'Chikkamagaluru': ['chikmagalur', 'chickmagalur', 'chikkamagaluru', 'chikmagaluru'],
  'Madikeri': ['madikeri', 'mercara', 'mercara'],
  'Kodagu': ['coorg', 'kodgu', 'kodag'],
  'Udupi': ['udupi', 'oodipu', 'udipi'],
  'Bagalkote': ['bagalkot', 'bagalkote', 'bagalkotta'],
  'Chitradurga': ['chitradurga', 'chitradurg'],
  'Hospet': ['hosapete', 'hospete'],
  'Ramanagara': ['ramanagara', 'ramanagaram'],
  'Channapatna': ['channapatna', 'channapatra'],
  'Gokarna': ['gokarna', 'gokarn'],
  'Srirangapatna': ['srirangapatna', 'srirangapatana'],
  'Kolar': ['kolara'],
  'Dharwad': ['dharawad'],
  'Mandya': ['manda'],
  'Haveri': ['haver'],
  'Raichur': ['raichoor'],
  'Bidar': ['bidar'],
  'Hampi': ['hampi'],
  'Thiruvananthapuram': ['trivandrum', 'thiruvanthapuram', 'tiruvananthapuram'],
  'Kochi': ['cochin'],
  'Kozhikode': ['calicut', 'kozhicode'],
  'Tiruchirappalli': ['trichy', 'tiruchirappally', 'tiruchi'],
  'Puducherry': ['pondicherry'],
  'Roma': ['rome'],
  'München': ['munich', 'munchen'],
  'Firenze': ['florence'],
  'Praha': ['prague'],
  'Genova': ['genoa']
};

function phoneticFold(s) {
  return fold(s);
}

function consonantSkeleton(s) {
  return fold(s).replace(/[aeiouy]/g, '');
}

// Prefix-anchored phonetic similarity for noisy place tokens. Levenshtein over
// the folded strings plus a bonus when the leading consonant skeleton agrees.
function phoneticScore(q, candidate) {
  const a = fold(q);
  const b = fold(candidate);
  const r = ratio(a, b);
  const skA = consonantSkeleton(a);
  const skB = consonantSkeleton(b);
  const skR = skA && skB ? ratio(skA, skB) : 0;
  let anchored = 0;
  const maxLen = Math.min(4, a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    if (a[i] === b[i]) anchored++;
    else break;
  }
  const prefix = maxLen > 0 ? anchored / maxLen : 0;
  return 0.5 * r + 0.3 * skR + 0.2 * prefix;
}

// Look up a canonical spelling for a token that failed to geocode strongly.
// Returns { canonical, strength } when a confident alias/phonetic match exists.
function aliasMatchFor(token) {
  const q = fold(token || '');
  if (!q || q.length < 3) return null;

  // 1. Exact variant / canonical spelling match.
  for (const [canonical, variants] of Object.entries(PLACE_ALIASES)) {
    if (fold(canonical) === q) return { canonical, strength: 'exact' };
    for (const v of variants) {
      if (fold(v) === q) return { canonical, strength: 'exact' };
    }
  }

  // 2. Phonetic match against the alias set (high threshold, so a random
  //    global place name is never rewritten into an Indian one).
  let best = null;
  for (const canonical of Object.keys(PLACE_ALIASES)) {
    const candFold = fold(canonical);
    if (candFold === q) continue;
    const sim = phoneticScore(q, candFold);
    if (sim >= 0.72 && (!best || sim > best.sim)) best = { canonical, strength: 'phonetic', sim };
  }
  return best;
}

export function normalizePlaceQuery(token) {
  const match = aliasMatchFor(token);
  return match ? match.canonical : null;
}

/* ===================================================================== */

const PLACE_MEMORY = [];
const PLACE_MEMORY_MAX = 40;

export function rememberCandidate(candidate) {
  if (!candidate || candidate.lat == null || candidate.lng == null || !candidate.placeName) return;
  const key = `${candidate.lat.toFixed(5)},${candidate.lng.toFixed(5)}`;
  const existing = PLACE_MEMORY.findIndex(m => `${m.lat.toFixed(5)},${m.lng.toFixed(5)}` === key);
  if (existing >= 0) PLACE_MEMORY.splice(existing, 1);
  PLACE_MEMORY.unshift(candidate);
  if (PLACE_MEMORY.length > PLACE_MEMORY_MAX) PLACE_MEMORY.length = PLACE_MEMORY_MAX;
}

const KANNADA = new Map([
  ['ಂ', 'm'], ['ಃ', 'h'],
  ['ಾ', 'aa'], ['ಿ', 'i'], ['ೀ', 'ii'], ['ು', 'u'], ['ೂ', 'uu'], ['ೃ', 'ru'],
  ['ೆ', 'e'], ['ೇ', 'ee'], ['ೈ', 'ai'], ['ೊ', 'o'], ['ೋ', 'oo'], ['ೌ', 'au'],
  ['ಅ', 'a'], ['ಆ', 'aa'], ['ಇ', 'i'], ['ಈ', 'ii'], ['ಉ', 'u'], ['ಊ', 'uu'],
  ['ಋ', 'ru'], ['ಎ', 'e'], ['ಏ', 'ee'], ['ಐ', 'ai'], ['ಒ', 'o'], ['ಓ', 'oo'], ['ಔ', 'au'],
  ['ಕ', 'k'], ['ಖ', 'kh'], ['ಗ', 'g'], ['ಘ', 'gh'], ['ಙ', 'ng'],
  ['ಚ', 'ch'], ['ಛ', 'chh'], ['ಜ', 'j'], ['ಝ', 'jh'], ['ಞ', 'ny'],
  ['ಟ', 't'], ['ಠ', 'th'], ['ಡ', 'd'], ['ಢ', 'dh'], ['ಣ', 'n'],
  ['ತ', 't'], ['ಥ', 'th'], ['ದ', 'd'], ['ಧ', 'dh'], ['ನ', 'n'],
  ['ಪ', 'p'], ['ಫ', 'ph'], ['ಬ', 'b'], ['ಭ', 'bh'], ['ಮ', 'm'],
  ['ಯ', 'y'], ['ರ', 'r'], ['ಱ', 'r'], ['ಲ', 'l'], ['ವ', 'v'],
  ['ಶ', 'sh'], ['ಷ', 'sh'], ['ಸ', 's'], ['ಹ', 'h'], ['ಳ', 'l'], ['ೞ', 'l'],
  ['ಕ್ಷ', 'ksh'], ['ಜ್ಞ', 'jna']
]);

const DEVANAGARI = new Map([
  ['ं', 'n'], ['ः', 'h'], ['ँ', 'n'],
  ['ा', 'aa'], ['ि', 'i'], ['ी', 'ii'], ['ु', 'u'], ['ू', 'uu'], ['ृ', 'ru'],
  ['े', 'e'], ['ै', 'ai'], ['ो', 'o'], ['ौ', 'au'],
  ['अ', 'a'], ['आ', 'aa'], ['इ', 'i'], ['ई', 'ii'], ['उ', 'u'], ['ऊ', 'uu'],
  ['ऋ', 'ru'], ['ए', 'e'], ['ऐ', 'ai'], ['ओ', 'o'], ['औ', 'au'],
  ['क', 'k'], ['ख', 'kh'], ['ग', 'g'], ['घ', 'gh'], ['ङ', 'ng'],
  ['च', 'ch'], ['छ', 'chh'], ['ज', 'j'], ['झ', 'jh'], ['ञ', 'ny'],
  ['ट', 't'], ['ठ', 'th'], ['ड', 'd'], ['ढ', 'dh'], ['ण', 'n'],
  ['त', 't'], ['थ', 'th'], ['द', 'd'], ['ध', 'dh'], ['न', 'n'],
  ['प', 'p'], ['फ', 'ph'], ['ब', 'b'], ['भ', 'bh'], ['म', 'm'],
  ['य', 'y'], ['र', 'r'], ['ल', 'l'], ['व', 'v'], ['श', 'sh'], ['ष', 'sh'],
  ['स', 's'], ['ह', 'h'], ['ळ', 'l'], ['क्ष', 'ksh'], ['ज्ञ', 'jna']
]);

const VOWELS_KN = new Set(['ಅ', 'ಆ', 'ಇ', 'ಈ', 'ಉ', 'ಊ', 'ಋ', 'ಎ', 'ಏ', 'ಐ', 'ಒ', 'ಓ', 'ಔ']);
const SIGNS_KN = new Set(['ಾ', 'ಿ', 'ೀ', 'ು', 'ೂ', 'ೃ', 'ೆ', 'ೇ', 'ೈ', 'ೊ', 'ೋ', 'ೌ']);
const VOWELS_DV = new Set(['अ', 'आ', 'इ', 'ई', 'उ', 'ऊ', 'ऋ', 'ए', 'ऐ', 'ओ', 'औ']);
const SIGNS_DV = new Set(['ा', 'ि', 'ी', 'ु', 'ू', 'ृ', 'े', 'ै', 'ो', 'ौ']);
const NASAL = new Set(['ಂ', 'ಃ', 'ं', 'ः', 'ँ']);
const HALANT_KANNADA = '್';
const HALANT_DEVANAGARI = '्';

function transliterate(text) {
  const kn = /[\u0C80-\u0CFF]/.test(text);
  const dv = /[\u0900-\u097F]/.test(text);
  const map = kn ? KANNADA : dv ? DEVANAGARI : null;
  if (!map) return text;
  const vowels = kn ? VOWELS_KN : VOWELS_DV;
  const signs = kn ? SIGNS_KN : SIGNS_DV;
  const halant = kn ? HALANT_KANNADA : HALANT_DEVANAGARI;

  let out = '';
  for (const ch of text) {
    if (ch === halant) {
      if (out.endsWith('a')) out = out.slice(0, -1);
      continue;
    }
    if (NASAL.has(ch)) {
      out += map.get(ch) || '';
      continue;
    }
    const r = map.get(ch);
    if (r == null) {
      out += ch;
      continue;
    }
    if (signs.has(ch)) {
      if (out.endsWith('a')) out = out.slice(0, -1);
      out += r;
    } else if (vowels.has(ch)) {
      out += r;
    } else {
      out += r + 'a';
    }
  }
  return out;
}

export function transliterateIfNeeded(q) {
  if (/[\u0C80-\u0CFF\u0900-\u097F]/.test(q)) {
    const t = transliterate(q);
    return t && t.trim() && t !== q ? t : null;
  }
  return null;
}

function fold(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(s) {
  return fold(s).replace(/\s+/g, '');
}

function coreOf(s) {
  return compact(s).replace(/[aeiouy]/g, '');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (Math.max(m, n) > 40) return Math.max(m, n);
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}

function ratio(a, b) {
  const l = Math.max(a.length, b.length);
  if (l === 0) return 1;
  return 1 - levenshtein(a, b) / l;
}

function rankCandidate(query, c) {
  const q = compact(query);
  const name = compact(c.placeName || '');
  const disp = compact(c.displayName || '');
  if (!q) return { score: 0, match: 'weak' };
  const best = Math.max(ratio(disp, q), ratio(name, q));
  let match = 'weak';
  const ql = q.length;

  if (name === q || (ql >= 12 && disp === q)) {
    match = 'exact';
  } else if (ql >= 2 && name && (name.startsWith(q) || q.startsWith(name))) {
    match = 'partial';
  } else if (name && best >= 0.82) {
    match = 'strong';
  } else if (name && ql >= 3 && best >= 0.6) {
    match = 'fuzzy';
  } else if (name && ql >= 4 && (coreOf(q) === coreOf(name) && coreOf(q).length >= 4 || best >= 0.5)) {
    match = 'fuzzy';
  }

  // "London" typed, "Greater London" found: when the query IS a whole word of
  // the candidate's PLACE NAME (not its address/road display string), it is
  // effectively the same place name, so promote it into the exact tier and let
  // importance break the tie between duplicates ("London" UK vs "London" CA).
  const qFold = fold(query);
  if (match === 'weak' && qFold.length >= 3 && name) {
    const nameWords = new Set(fold(c.placeName || '').split(/\s+/).filter(Boolean));
    if (nameWords.has(qFold)) match = 'exact';
  }
  return { score: match === 'exact' ? Math.max(best, 1) : best, match };
}

const MATCH_RANK = { exact: 0, strong: 1, partial: 2, fuzzy: 3, weak: 4 };

const POPULATED_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'township', 'municipality', 'suburb']);
const ADMIN_TYPES = new Set(['administrative', 'county', 'state_district', 'district', 'region']);
const POI_TYPES = new Set(['estate_agent', 'hospital', 'bakery', 'cinema', 'clothes', 'pharmacy', 'motorway', 'residential', 'path', 'tertiary', 'retail', 'hotel', 'restaurant', 'shop', 'office']);

// A candidate that represents an actual location as opposed to a business,
// road or amenity POI (Nominatim often surfaces POIs for loose full-text
// matches like "banglore" -> estate agents in Bengaluru).
function isPlaceLike(c) {
  return POPULATED_TYPES.has(c.type) || ADMIN_TYPES.has(c.type);
}

// Lower weight wins when two candidates collapse to the same place.
function candidateWeight(c) {
  let w = 0;
  if (POPULATED_TYPES.has(c.type)) w -= 1000;
  else if (ADMIN_TYPES.has(c.type)) w += 1000;
  else w += 2000;
  if (c.importance != null) w -= c.importance * 100;
  return w;
}

// Strongest stable identifier for a single geocoder result.
function candidateIdentityKey(c) {
  if (c.osmType && c.osmId != null) return `id:${c.osmType}:${c.osmId}`;
  const lat = (c.lat != null ? c.lat : 0).toFixed(3);
  const lng = (c.lng != null ? c.lng : 0).toFixed(3);
  return `n:${compact(c.placeName || '')}|${lat},${lng}`;
}

// Place-merge key: same name AND essentially the same coordinates (~110m)
// is the same place even if the provider returned it under a different id
// (e.g. a city node vs. its boundary relation). Distinct same-name places
// in different locations keep different coordinates, so they stay separate.
function candidateNameCoordKey(c) {
  const name = compact(c.placeName || '');
  if (name) {
    const lat = (c.lat != null ? c.lat : 0).toFixed(3);
    const lng = (c.lng != null ? c.lng : 0).toFixed(3);
    return `${name}|${lat},${lng}`;
  }
  return candidateIdentityKey(c);
}

// Same normalized name AND same region anchor (e.g. "Bengaluru" returned
// once as the city node and once as its containing district) is the same
// place regardless of small centroid differences. Identical name+region
// for genuinely different places is effectively impossible in practice.
function candidateNameRegionKey(c) {
  const name = compact(c.placeName || '');
  const region = compact(c.region || '');
  if (name && region) return `${name}|${region}`;
  return null;
}

function collapseByKey(candidates, keyFn) {
  const out = new Map();
  for (const c of candidates) {
    const k = keyFn(c);
    if (k == null) {
      out.set(c, c);
      continue;
    }
    const existing = out.get(k);
    if (!existing) {
      out.set(k, c);
      continue;
    }
    if (candidateWeight(c) < candidateWeight(existing)) out.set(k, c);
  }
  return [...out.values()];
}

function dedupeCandidates(candidates) {
  let list = collapseByKey(candidates, candidateIdentityKey);
  list = collapseByKey(list, candidateNameRegionKey);
  list = collapseByKey(list, candidateNameCoordKey);
  return list;
}

// Global search with a regional preference (Karnataka > India > rest of the
// world). This is a RANKING signal only - it never removes candidates, so
// legitimate international results always remain searchable.
function regionalTier(c) {
  const cc = String(c.countryCode || '').toUpperCase();
  if (cc === 'IN') {
    const hay = `${c.region || ''} ${c.displayName || ''} ${c.placeName || ''}`;
    if (/karnataka|karnataka,/i.test(hay)) return 2;
    return 1;
  }
  return 0;
}

// If the user explicitly typed a region/country token (e.g. "London UK",
// "Kathmandu Nepal", "Dubai UAE"), candidates carrying that token are boosted
// strongly so explicit user intent overrides the default regional preference.
function explicitRegionBoost(c, q) {
  const qFold = fold(q || '');
  if (!qFold) return 0;
  const cText = fold(`${c.displayName || ''} ${c.region || ''} ${c.country || ''}`);
  if (!cText) return 0;
  // Business/road POIs must never receive a regional boost — a firm literally
  // named "Banglore Realty" must not outrank the city of Bengaluru. Only real
  // locations get boosted, so typed region qualifiers inflate places, not POIs.
  if (!isPlaceLike(c)) return 0;
  const qTokens = new Set(qFold.split(' '));
  let boost = 0;
  for (const t of qTokens) {
    if (t.length <= 2) continue;
    if (cText.split(' ').includes(t)) boost = Math.max(boost, 0.2);
  }
  return boost;
}

// Combined ranking score: base textual similarity + small regional preference
// + explicit query-region boost. Match tier (exact/strong/partial/fuzzy) is
// still the primary ordering key, so a true international exact match always
// beats a weak Indian fuzzy match.
function rankingScore(c, q, score) {
  return score + regionalTier(c) * 0.05 + explicitRegionBoost(c, q);
}

export function classifyForQuery(query, candidates) {
  const latinQ = compact(query);
  const alias = normalizePlaceQuery(query);
  if (!latinQ && candidates.length > 0) {
    const trusted = candidates.slice(0, 6).map(c => ({ c, match: 'exact', score: 1, order: 0 }));
    return { status: 'matches', ranked: trusted, top: trusted, confident: true, ambiguous: false, head: null };
  }

  const ranked = candidates.map(c => {
    let r = rankCandidate(query, c);
    // Query normalization (alias/phonetic): when the user typed/said a known
    // variant of a canonical place ("Tumko", "Bangalore", "Mangalore"), a
    // geocoder hit whose name IS that canonical place is promoted to an exact
    // match; any same-name foreign coincidence ("Tumko, Sudan") is demoted out
    // of the exact tier so the intended Indian place reliably wins ranking.
    if (alias) {
      if (fold(c.placeName || '') === fold(alias)) {
        r = { score: 1, match: 'exact' };
      } else if (MATCH_RANK[r.match] < MATCH_RANK.strong) {
        r = { ...r, match: 'strong' };
      }
    }
    return { ...r, c };
  });
  const sorted = ranked
    .map((r, i) => ({ ...r, order: i }))
    .sort((a, b) => (MATCH_RANK[a.match] - MATCH_RANK[b.match]) ||
      (rankingScore(b.c, query, b.score) - rankingScore(a.c, query, a.score)) ||
      (+POPULATED_TYPES.has(b.c.type) - +POPULATED_TYPES.has(a.c.type)) ||
      ((b.c.importance || 0) - (a.c.importance || 0)) || (a.order - b.order));

  const good = sorted.filter(r => r.match !== 'weak');
  if (good.length === 0) {
    return { status: 'none', ranked: sorted, top: [], confident: false, ambiguous: false, head: null };
  }

  const sameNameRegions = new Map();
  const sameNameNonAdmin = new Map();
  for (const g of good) {
    const key = compact(g.c.placeName || '');
    if (!key) continue;
    const regionKey = compact(g.c.region || '');
    const arr = sameNameRegions.get(key) || new Set();
    arr.add(regionKey);
    sameNameRegions.set(key, arr);
    if (g.match === 'exact' && !ADMIN_TYPES.has(g.c.type)) {
      sameNameNonAdmin.set(key, (sameNameNonAdmin.get(key) || 0) + 1);
    }
  }
  let ambiguous = false;
  for (const [key, regions] of sameNameRegions) {
    if (key.length >= 4 && regions.size >= 2 && compact(query).length <= 8 && (sameNameNonAdmin.get(key) || 0) !== 1) {
      ambiguous = true;
      break;
    }
  }

  if (!ambiguous && good[0] && good[0].match === 'partial') {
    const partialGroup = good.filter(r => r.match === 'partial');
    const distinctNames = new Set(partialGroup.map(r => compact(r.c.placeName || '')));
    if (distinctNames.size >= 2 && compact(query).length <= 8) {
      ambiguous = true;
    }
  }

  const top = good;
  const topMatch = top[0].match;
  let confident = (topMatch === 'exact' || topMatch === 'strong' || topMatch === 'partial') && !ambiguous;

  let head = null;
  if (ambiguous) head = 'which';
  else if (topMatch === 'fuzzy') head = 'didyoumean';

  // When the top candidate is an unambiguous exact match clearly more
  // important than its rivals ("Rome, Italy" 0.86 vs any US Rome ~0.5), it is
  // what the user almost certainly meant — resolve it instead of nagging
  // "which?".
  if (ambiguous && top.length >= 2 && top[0].match === 'exact') {
    const gap = (top[0].c.importance || 0) - (top[1].c.importance || 0);
    if (gap >= 0.15) {
      ambiguous = false;
      confident = true;
      head = null;
    }
  }

  if (confident && topMatch === 'partial' && latinQ.length < 14) {
    const topName = compact(top[0].c.placeName || '');
    if (latinQ.length < topName.length && topName.length - latinQ.length > 4) {
      confident = false;
      if (!head) head = 'didyoumean';
    }
  }

  return { status: 'matches', ranked: sorted, top, confident, ambiguous, head };
}

function pickPlaceName(result) {
  const a = result.address || {};
  return a.city || a.town || a.village || a.hamlet || a.municipality ||
    a.suburb || a.county || a.state_district || a.township || result.display_name.split(',')[0] || a.name;
}

function pickRegion(result) {
  const a = result.address || {};
  const second = a.county || a.state_district || a.region || a.district;
  const state = a.state || a.country;
  const first = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb;
  const parts = [];
  if (second && second !== first) parts.push(second);
  if (state && state !== second) parts.push(state);
  if (a.country && a.country !== state && a.country !== second) parts.push(a.country);
  return parts.join(', ');
}

function parseCandidate(d) {
  const osmType = d.osm_type ? String(d.osm_type) : null;
  const osmId = d.osm_id != null ? Number(d.osm_id) : null;
  const addr = d.address || {};
  const nd = d.namedetails || {};
  const defaultName = String(pickPlaceName(d) || d.display_name || '').trim();
  const defaultDisplay = d.display_name || '';
  const latinName = latinNameFor(nd, defaultName, defaultDisplay);
  return {
    placeName: latinName || defaultName,
    region: pickRegion(d),
    displayName: latinName && isNonLatin(defaultDisplay)
      ? [latinName, addr.state, addr.country].filter(Boolean).join(', ')
      : defaultDisplay,
    needsEnglishLabels: isNonLatin(defaultDisplay) && !!latinName,
    country: String(addr.country || '').trim(),
    countryCode: String(addr.country_code || '').toUpperCase().trim(),
    lat: parseFloat(d.lat),
    lng: parseFloat(d.lon),
    importance: d.importance != null ? d.importance : 0,
    type: d.type,
    osmType,
    osmId,
    source: 'nominatim'
  };
}

// Preferred Latin (English) name from Nominatim `namedetails`, patterned so
// global places keep readable, searchable names regardless of their default
// (Arabic/Devanagari/CJK) display name. Keeps the original name when it is
// already Latin.
function latinNameFor(nd, defaultName, defaultDisplay) {
  if (!isNonLatin(defaultDisplay) && !isNonLatin(defaultName)) return null;
  const candidates = [
    nd['_place_name:en'],
    nd['name:en'],
    nd['int_name'],
    ...Object.keys(nd).sort().filter(k => k.endsWith('-Latn')).map(k => nd[k])
  ];
  for (const c of candidates) {
    const v = String(c || '').trim();
    if (v && !isNonLatin(v)) return v;
  }
  return null;
}

function isNonLatin(s) {
  return /[^\u0000-\u024F]/.test(String(s || ''));
}

async function nominatimQuery(q, limit, signal, { country = null } = {}) {
  const params = new URLSearchParams({
    q,
    format: 'json',
    limit: String(limit),
    addressdetails: '1',
    namedetails: '1',
    dedupe: '1',
    accept_language: 'en'
  });
  if (country) params.set('countrycodes', country);
  const res = await throttledFetch(`${NOMINATIM_SEARCH_URL}?${params}`, { headers: SEARCH_HEADERS, signal });
  if (res.status === 429) {
    const err = new Error('rate-limited');
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('geocoder-error');
    err.httpError = true;
    throw err;
  }
  return res.json();
}

async function queryRegion(queries, country, limit, signal) {
  const seen = new Map();
  let rateLimited = false;
  let networkError = false;
  for (const queryString of queries) {
    if (!queryString) continue;
    try {
      const data = await nominatimQuery(queryString, limit, signal, { country });
      for (const d of data || []) {
        const c = parseCandidate(d);
        const key = `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
        if (!seen.has(key)) seen.set(key, c);
      }
      if (seen.size > 0) break;
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      if (err && err.rateLimited) {
        // Single retry after a polite pause; the request gate above already
        // spaces traffic, so this is insurance against bursts from other
        // tabs/processes sharing the same public IP.
        await new Promise(res => setTimeout(res, 1200));
        try {
          const data = await nominatimQuery(queryString, limit, signal, { country });
          for (const d of data || []) {
            const c = parseCandidate(d);
            const key = `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
            if (!seen.has(key)) seen.set(key, c);
          }
          continue;
        } catch (retryErr) {
          if (retryErr && retryErr.rateLimited) { rateLimited = true; break; }
          if (retryErr && retryErr.name === 'AbortError') throw retryErr;
        }
      }
      if (err && err.httpError) { networkError = true; break; }
      if (err && err.name === 'TypeError' && /fetch/i.test(err.message)) { networkError = true; break; }
    }
  }
  return { seen, rateLimited, networkError };
}

function buildQueries(q) {
  const trimmed = (q || '').trim();
  const queries = [trimmed];
  const t = transliterateIfNeeded(trimmed);
  if (t && t !== trimmed && !queries.includes(t)) queries.push(t);
  return queries;
}

export async function searchCandidates(query, { limit = 8, signal } = {}) {
  const q = (query || '').trim();
  if (!q) return [];
  const cacheKey = fold(q);
  const hit = searchCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts < CACHE_TTL)) {
    return hit.results;
  }

  const queries = buildQueries(q);
  const hasIndicScript = /[\u0C80-\u0CFF\u0900-\u097F]/.test(q);
  const seen = new Map();
  const absorb = (r) => { for (const [k, v] of r.seen) if (!seen.has(k)) seen.set(k, v); };

  try {
    // India-targeted first (cheap, one request). Only widen to the whole world
    // when India produced nothing confidently usable, so global places always
    // remain reachable while request volume stays gentle on Nominatim
    // (public tier limits to ~1 req/s; hammering it causes the 429s that show
    // up as "no match found for any place").
    if (!hasIndicScript) {
      const india = await queryRegion(queries, INDIA_COUNTRY, limit, signal);
      absorb(india);
      const indiaGood = classifyForQuery(q, [...seen.values()]);
      const usable = (indiaGood.ranked || []).some(r => r.match !== 'weak');
      if (!usable && !india.rateLimited && !india.networkError) {
        absorb(await queryRegion(queries, null, limit, signal));
      }
    } else {
      absorb(await queryRegion(queries, null, limit, signal));
    }

    // Alias/phonetic canonicalization: when the raw token is a known ASR
    // variant ("Tumko") or alternate spelling ("Bangalore"), also fetch the
    // canonical spelling's results so the intended Indian place can win
    // ranking over an accidental foreign same-name hit ("Tumko, Sudan").
    const alias = normalizePlaceQuery(q);
    if (alias && fold(alias) !== fold(q)) {
      const alreadyCanonical = [...seen.values()].some(c => fold(c.placeName || '') === fold(alias) && isPlaceLike(c));
      if (!alreadyCanonical) {
        absorb(await queryRegion(buildQueries(alias), null, limit, signal));
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
  }

  for (const mc of PLACE_MEMORY) {
    const r = rankCandidate(q, mc);
    if (r.match !== 'weak') {
      const key = `${mc.lat.toFixed(5)},${mc.lng.toFixed(5)}`;
      if (!seen.has(key)) seen.set(key, mc);
    }
  }
  const unique = dedupeCandidates([...seen.values()]);
  // Keep a wider pool so ranking (classifyForQuery) can still surface global
  // results even when late Indian candidates fill the first slots.
  const results = unique.slice(0, Math.max(limit * 3, 12));
  searchCache.set(cacheKey, { ts: Date.now(), results });
  return results;
}

export function clearSearchCache() {
  searchCache.clear();
}

export async function resolveLocationText(query, { limit = 8, signal } = {}) {
  try {
    const candidates = await searchCandidates(query, { limit, signal });
    const analysis = classifyForQuery(query, candidates);
    if (analysis.status === 'none') {
      return { status: 'none', query };
    }
    if (analysis.confident) {
      const pick = analysis.ambiguous
        ? null
        : analysis.top[0].c;
      if (pick) {
        rememberCandidate(pick);
        return { status: 'resolved', query, selection: pick, match: analysis.top[0].match };
      }
      return { status: 'suggest', query, suggestions: analysis.top.map(r => r.c), didYouMean: true };
    }
    return {
      status: 'suggest',
      query,
      suggestions: analysis.top.slice(0, 5).map(r => r.c),
      didYouMean: analysis.head === 'didyoumean',
      ambiguous: analysis.ambiguous
    };
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    if (err && err.rateLimited) return { status: 'error', reason: 'busy' };
    if (err && (err.httpError || (err.name === 'TypeError' && /fetch/i.test(err.message)))) {
      return { status: 'error', reason: 'network' };
    }
    return { status: 'error', reason: 'unknown' };
  }
}

export async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: 'jsonv2',
    addressdetails: '1',
    zoom: '15',
    accept_language: 'en'
  });
  const res = await throttledFetch(`${NOMINATIM_REVERSE_URL}?${params}`, { headers: SEARCH_HEADERS });
  if (res.status === 429) {
    const err = new Error('rate-limited');
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error('reverse-geocoder-error');
  const d = await res.json();
  if (!d || d.lat == null || d.lon == null) return null;
  const c = parseCandidate(d);
  return {
    ...c,
    shortName: c.placeName || 'This location',
    lat: parseFloat(d.lat),
    lng: parseFloat(d.lon)
  };
}

export async function geocodeLocation(query) {
  const res = await resolveLocationText(query, { limit: 5 });
  if (res.status === 'resolved') {
    const c = res.selection;
    return {
      lat: c.lat,
      lng: c.lng,
      displayName: c.displayName,
      shortName: c.placeName,
      type: c.type,
      importance: c.importance,
      source: c.source,
      alternatives: [],
      suggestion: null
    };
  }
  if (res.status === 'suggest') {
    return {
      error: null,
      suggestion: res.suggestions,
      didYouMean: res.didYouMean
    };
  }
  if (res.status === 'error') {
    return { error: 'Location search is temporarily unavailable. Please try again.' };
  }
  return { error: `No matching places found for "${(query || '').trim()}". Try a nearby city or check the spelling.` };
}

export class LocationAutocomplete {
  constructor(input, { onSelect, onInput, debounce = 300 } = {}) {
    this.input = input;
    this.onSelect = onSelect || null;
    this.onInput = onInput || null;
    this.debounce = debounce;
    this.ctrl = null;
    this.activeIndex = -1;
    this.items = [];
    this.analysis = null;
    this.open = false;
    this._timer = null;
    this._reqId = 0;
    this._ignoreBlur = false;
    this._suppressInputEvent = false;
    this._selectionVersion = 0;
    this.input._autocomplete = this;
    this.input._selectionVersion = 0;
    this._build();
    this._bind();
  }

  _build() {
    this.drop = document.createElement('div');
    this.drop.className = 'loc-dropdown';
    this.drop.setAttribute('role', 'listbox');
    this.drop.innerHTML = '';
    this.drop.style.display = 'none';
    this.input.insertAdjacentElement('afterend', this.drop);
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-controls', this.drop.id || (this.drop.id = 'loc-dd-' + Math.random().toString(36).slice(2, 8)));
  }

  _bind() {
    this.input.addEventListener('input', () => {
      if (this._suppressInputEvent) return;
      this.input._editSeq = (this.input._editSeq || 0) + 1;
      this._clearSelection();
      this._schedule(this.input.value);
      if (this.onInput) this.onInput();
    });
    this.input.addEventListener('focus', () => {
      if (this.input.value.trim().length >= 2) this._schedule(this.input.value);
    });
    this.input.addEventListener('keydown', (e) => this._onKeydown(e));
    this.input.addEventListener('blur', () => {
      if (this._ignoreBlur) { this._ignoreBlur = false; return; }
      setTimeout(() => this.close(), 160);
    });
    this.drop.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-index]')) e.preventDefault();
      const row = e.target.closest('[data-index]');
      if (row) {
        const item = this.items[parseInt(row.dataset.index, 10)];
        if (item) this.selectItem(item);
      }
    });
    this.drop.addEventListener('pointerdown', (e) => {
      this._ignoreBlur = true;
    });
  }

  _clearSelection() {
    if (this.input._selection) {
      this.input._selection = null;
      this.input._selectionVersion = (this.input._selectionVersion || 0) + 1;
    }
  }

  _schedule(q) {
    clearTimeout(this._timer);
    if (this.ctrl) { this.ctrl.abort(); this.ctrl = null; }
    this._reqId = (this._reqId || 0) + 1;
    const value = (q || '').trim();
    if (value.length < 2) {
      this.close();
      return;
    }
    this._renderLoading();
    const reqId = this._reqId;
    this._timer = setTimeout(() => this._run(value, reqId), this.debounce);
  }

  async _run(q, reqId) {
    if (reqId !== this._reqId || this.input.value.trim() !== q) return;
    this.ctrl = new AbortController();
    try {
      const candidates = await searchCandidates(q, { limit: 8, signal: this.ctrl.signal });
      if (reqId !== this._reqId || this.input.value.trim() !== q) return;
      const analysis = classifyForQuery(q, candidates);
      this.analysis = analysis;
      const nodes = analysis.top.slice(0, 6);
      if (nodes.length === 0) {
        this._renderNone();
        this.open = true;
        this.drop.style.display = 'block';
        return;
      }
      this._renderItems(nodes, analysis);
      this.open = true;
      this.drop.style.display = 'block';
      this.input.setAttribute('aria-expanded', 'true');
      this._move(1);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (reqId !== this._reqId) return;
      this._renderError();
      this.open = true;
      this.drop.style.display = 'block';
    }
  }

  _onKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.open) { this._schedule(this.input.value); return; }
      this._move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.open) { return; }
      this._move(-1);
    } else if (e.key === 'Enter') {
      if (this.open && this.activeIndex >= 0 && this.items[this.activeIndex]) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.selectItem(this.items[this.activeIndex]);
      }
    } else if (e.key === 'Escape') {
      if (this.open) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); this.close(); }
    } else if (e.key === 'Tab') {
      this.close();
    }
  }

  _move(dir) {
    if (this.items.length === 0) return;
    let idx = this.activeIndex;
    if (idx < 0) idx = dir > 0 ? -1 : 0;
    idx += dir;
    if (idx < 0) idx = this.items.length - 1;
    if (idx >= this.items.length) idx = 0;
    this.activeIndex = idx;
    this.items.forEach((n, i) => {
      n.classList.toggle('active', i === idx);
      n.setAttribute('aria-selected', i === idx ? 'true' : 'false');
    });
    this.input.setAttribute('aria-activedescendant', this.items[idx].id);
  }

  _renderLoading() {
    this.drop.innerHTML = `<div class="loc-row loc-message"><span class="loc-spinner"></span><span>Searching…</span></div>`;
    this.items = [];
    this.open = true;
    this.drop.style.display = 'block';
  }

  _renderNone() {
    this.drop.innerHTML = `
      <div class="loc-row loc-message" role="presentation">
        <span>🗺️</span>
        <span class="loc-msg-text"><b>No matching places found</b><span class="loc-msg-sub">Try a nearby city or check the spelling.</span></span>
      </div>`;
    this.items = [];
    this.input.setAttribute('aria-expanded', 'true');
  }

  _renderError() {
    this.drop.innerHTML = `
      <div class="loc-row loc-message" role="presentation">
        <span>🛠️</span>
        <span class="loc-msg-text"><b>Couldn't search locations. Try again.</b></span>
      </div>`;
    this.items = [];
    this.input.setAttribute('aria-expanded', 'true');
  }

  _renderItems(nodes, analysis) {
    const html = [];
    if (analysis.head === 'didyoumean') {
      html.push(`<div class="loc-head">Did you mean?</div>`);
    } else if (analysis.head === 'which') {
      html.push(`<div class="loc-head">Which place did you mean?</div>`);
    }
    nodes.forEach((r, i) => {
      const c = r.c;
      html.push(`
        <div class="loc-row" data-index="${i}" id="${this.drop.id}-opt-${i}" role="option" aria-selected="false">
          <span class="loc-pin">📍</span>
          <span class="loc-main">
            <span class="loc-name">${escapeHtml(c.placeName || (c.displayName.split(',')[0] || ''))}</span>
            ${c.region ? `<span class="loc-region">${escapeHtml(c.region)}</span>` : ''}
          </span>
        </div>`);
    });
    this.drop.innerHTML = html.join('');
    this.items = Array.from(this.drop.querySelectorAll('[data-index]'));
    this.items.forEach((el, i) => { el.c = nodes[i] ? nodes[i].c : null; });
  }

  showSuggestion(suggestions, { didYouMean = false, heading = null } = {}) {
    this.analysis = {
      head: heading || (didYouMean ? 'didyoumean' : null),
      confident: false,
      top: suggestions.map(c => ({ c, match: 'strong', score: 1 }))
    };
    const nodes = suggestions.slice(0, 5);
    const html = [];
    if (this.analysis.head === 'didyoumean') html.push('<div class="loc-head">Did you mean?</div>');
    else if (this.analysis.head === 'which') html.push('<div class="loc-head">Which place did you mean?</div>');
    nodes.forEach((c, i) => {
      html.push(`
        <div class="loc-row" data-index="${i}" id="${this.drop.id}-opt-${i}" role="option" aria-selected="false">
          <span class="loc-pin">📍</span>
          <span class="loc-main">
            <span class="loc-name">${escapeHtml(c.placeName || (c.displayName.split(',')[0] || ''))}</span>
            ${c.region ? `<span class="loc-region">${escapeHtml(c.region)}</span>` : ''}
          </span>
        </div>`);
    });
    this.drop.innerHTML = html.join('');
    this.items = Array.from(this.drop.querySelectorAll('[data-index]'));
    this.items.forEach((el, i) => { el.c = nodes[i] || null; });
    this.open = true;
    this.drop.style.display = 'block';
    this.input.setAttribute('aria-expanded', 'true');
    if (this.items.length > 0) this._move(1);
  }

  selectItem(item) {
    const c = item.c || {};
    if (c.placeName && c.lat != null) rememberCandidate(c);
    this._suppressInputEvent = true;
    this.input.value = c.placeName || (c.displayName || '').split(',')[0] || this.input.value;
    this._suppressInputEvent = false;
    this.input._editSeq = (this.input._editSeq || 0) + 1;
    this._selectionVersion = (this._selectionVersion || 0) + 1;
    this.input._selection = c;
    this.input._selectionVersion = this._selectionVersion;
    this.close();
    if (this.onSelect) this.onSelect(c);
  }

  close() {
    clearTimeout(this._timer);
    this.open = false;
    this.activeIndex = -1;
    this.items = [];
    this.analysis = null;
    this.drop.style.display = 'none';
    this.drop.innerHTML = '';
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this._reqId = (this._reqId || 0) + 1;
    if (this.ctrl) { this.ctrl.abort(); this.ctrl = null; }
  }

  destroy() {
    clearTimeout(this._timer);
    this.close();
    this.drop.remove();
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}