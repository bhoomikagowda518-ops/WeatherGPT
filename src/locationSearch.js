const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const SEARCH_HEADERS = { 'User-Agent': 'WeatherGPT-RouteIntelligence/1.0' };
const CACHE_TTL = 10 * 60 * 1000;

const INDIA_COUNTRY = 'IN';
const INDIA_FIRST = true;

const searchCache = new Map();

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
  return { score: best, match };
}

const MATCH_RANK = { exact: 0, strong: 1, partial: 2, fuzzy: 3, weak: 4 };

const POPULATED_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'township', 'municipality', 'suburb']);
const ADMIN_TYPES = new Set(['administrative', 'county', 'state_district', 'district', 'region']);

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

export function classifyForQuery(query, candidates) {
  const latinQ = compact(query);
  if (!latinQ && candidates.length > 0) {
    const trusted = candidates.slice(0, 6).map(c => ({ c, match: 'exact', score: 1, order: 0 }));
    return { status: 'matches', ranked: trusted, top: trusted, confident: true, ambiguous: false, head: null };
  }

  const ranked = candidates.map(c => {
    const r = rankCandidate(query, c);
    return { ...r, c };
  });
  const sorted = ranked
    .map((r, i) => ({ ...r, order: i }))
    .sort((a, b) => (MATCH_RANK[a.match] - MATCH_RANK[b.match]) || (b.score - a.score) ||
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
  return {
    placeName: String(pickPlaceName(d) || d.display_name || '').trim(),
    region: pickRegion(d),
    displayName: d.display_name || '',
    lat: parseFloat(d.lat),
    lng: parseFloat(d.lon),
    importance: d.importance != null ? d.importance : 0,
    type: d.type,
    osmType,
    osmId,
    source: 'nominatim'
  };
}

async function nominatimQuery(q, limit, signal, { country = null } = {}) {
  const params = new URLSearchParams({
    q,
    format: 'json',
    limit: String(limit),
    addressdetails: '1',
    dedupe: '1',
    accept_language: 'en'
  });
  if (country) params.set('countrycodes', country);
  const res = await fetch(`${NOMINATIM_SEARCH_URL}?${params}`, { headers: SEARCH_HEADERS, signal });
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
      if (err && err.rateLimited) { rateLimited = true; break; }
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

  try {
    const india = await queryRegion(queries, INDIA_FIRST ? INDIA_COUNTRY : null, limit, signal);
    for (const [k, v] of india.seen) seen.set(k, v);

    // India-first, not India-only: only when India returns nothing for a
    // non-Indic query do we widen to the whole world so global places still work.
    if (INDIA_FIRST && seen.size === 0 && !hasIndicScript && !india.rateLimited && !india.networkError) {
      const global = await queryRegion(queries, null, limit, signal);
      for (const [k, v] of global.seen) {
        if (!seen.has(k)) seen.set(k, v);
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
  const results = unique.slice(0, limit);
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
  const res = await fetch(`${NOMINATIM_REVERSE_URL}?${params}`, { headers: SEARCH_HEADERS });
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
    this.input._autocomplete = this;
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
  }

  _clearSelection() {
    if (this.input._selection) this.input._selection = null;
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
    this.open = true;
    this.drop.style.display = 'block';
    this.input.setAttribute('aria-expanded', 'true');
    if (this.items.length > 0) this._move(1);
  }

  selectItem(item) {
    const c = item.c || {};
    if (c.placeName && c.lat != null) rememberCandidate(c);
    this.input.value = c.placeName || (c.displayName || '').split(',')[0] || this.input.value;
    this.input._selection = c;
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