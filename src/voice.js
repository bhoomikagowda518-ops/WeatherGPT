export const VOICE_LANGS = [
  { code: 'en-IN', label: 'English' }
];

export const HERE_TOKEN = '\u00ABhere\u00BB';

/* =====================================================================
   Natural-language intent extraction (English).
   The geocoder remains the source of truth: this module only decides
   WHAT was said (origin/destination/mode), never coordinates.
   It is pattern-based, but compositional: marker phrases + filler-word
   trimming, so it understands free-form speech without a giant list of
   exact sentences.
   ===================================================================== */

const JUNK = new Set([
  // English function words, verbs and filler (Indian-English friendly)
  'i', "i'm", 'im', 'i m', 'me', 'my', 'mine', 'we', 'us', 'you', 'your', 'yours',
  'he', 'she', 'it', 'they', 'them', 'need', 'wanna', 'want', 'wants', 'would',
  'will', 'shall', 'have', 'has', 'had', 'can', 'could', 'should', 'please',
  'show', 'take', 'took', 'give', 'find', 'get', 'got', 'make', 'made', 'go',
  'goes', 'going', 'gone', 'went', 'reach', 'reaching', 'drive', 'driving',
  'ride', 'riding', 'travel', 'travelling', 'traveling', 'travell', 'plan',
  'planning', 'the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'route',
  'road', 'way', 'path', 'weather', 'condition', 'conditions', 'best', 'better',
  'safe', 'safest', 'fast', 'fastest', 'quick', 'quickest', 'tomorrow', 'today',
  'tonight', 'now', 'right', 'this', 'that', 'there', 'here', 'they', 'are',
  'be', 'do', 'does', 'is', 'am', 'its', 'it s', 'if', 'then', 'than', 'so',
  'some', 'about', 'after', 'before', 'out', 'current', 'currently', 'location',
  'position', 'when', 'what', 'how', 'who', 'why', 'day', 'soon', 'yes', 'no',
  'ok', 'okay', 'via', 'through', 'thru', 'straight', 'direct', 'directly',
  'first', 'last', 'please', 'home', 'start', 'starting', 'starter', 'leave',
  'leaving', 'left', 'depart', 'head', 'heading', 'follow', 'follows',
  'towards', 'toward', 'instead', 'near', 'anywhere', 'somewhere', 'finally',
  'till', 'until', 'map', 'maps', 'enter', 'entering', 'arrive', 'arriving',
  'arrival', 'departure', 'auto', 'rider', 'drivers', 'driver', 'friend',
  'family', 'him', 'her', 'like', 'look', 'looks', 'try', 'help', 'helping',
  'actually', 'wait', 'change', 'changed', 'update', 'switch', 'replace',
  'correction', 'edit', 'modify', 'instead', 'rather', 'drop', 'pick', 'visit',
  'meet', 'see', 'never', 'always', 'mostly', 'also', 'even', 'just', 'only',
  'very', 'really', 'much', 'more', 'most', 'little', 'less', 'around',
  'which', 'qui', 'faster', 'slower', 'quicker', 'cheaper', 'shorter',
  'closer', 'compare', 'comparing', 'versus', 'vs', 'opposite',
  'hello', 'hi', 'hey', 'namaste', 'namaskar', 'vanakkam',
  'begin', 'beginning', 'ended', 'ends', 'finish', 'finished', 'final',
  'goal', 'target', 'place', 'city', 'town', 'village', 'district', 'state',
  'area', 'stop', 'stops', 'engine', 'vehicle', 'journey', 'trip', 'route',
  'destination', 'destinations', 'origin', 'origins', 'endpoint', 'dropoff',
  // Roman Kannada / Hindi
  'nanu', 'naan', 'nanna', 'nanage', 'namage', 'main', 'mainn', 'mujhe',
  'mujh', 'hum', 'humein', 'humko', 'iko', 'madi', 'beeg', 'ichi',
  'hogbeku', 'hogona', 'hogo', 'hodbeku', 'talupbeku', 'hogu', 'hogi', 'hogolli',
  'hogatte', 'pochch', 'hu', 'han', 'illa', 'ilalla', 'bedha', 'bedi',
  'batao', 'bataye', 'dikhao', 'dekho', 'karao', 'hoga', 'hai', 'hain',
  'jao', 'jaun', 'jana', 'jani', 'jata', 'jat', 'chalu', 'chalegi', 'chorho',
  'sakta', 'sakti', 'sakte', 'karna', 'kare', 'karne', 'aana', 'pahunch',
  'tha', 'the', 'hoon', 'ka', 'ki', 'ke', 'ko'
]);

/* Marker phrases that introduce a place. Longest-first matching. */
const ORIGIN_MARKERS = [
  ['from'],
  ['starting', 'from'], ['start', 'from'], ['start', 'at'], ['starting', 'at'],
  ['coming', 'from'], ['came', 'from'], ['leave', 'from'], ['leaving', 'from'],
  ['leaving'], ['departing', 'from'], ['depart', 'from'], ['departing'],
  ['driving', 'from'], ['travelling', 'from'], ['traveling', 'from'],
  ['travel', 'from'], ['heading', 'out', 'from'], ['heading', 'out', 'of'],
  ['headed', 'out', 'from'], ['headed', 'out', 'of'],
  ['i', 'am', 'in'], ['i', 'am', 'at'], ['im', 'in'], ['im', 'at'],
  ['i', 'm', 'in'], ['i', 'm', 'at'], ['i', 'am', 'based', 'in'],
  ['im', 'based', 'in'], ['based', 'in'], ['staying', 'in'],
  ['located', 'in'], ['currently', 'in'], ['i', 'am', 'currently', 'in'],
  ['im', 'currently', 'in'], ['i', 'currently', 'in'],
  ['i', 'am', 'located', 'in'], ['im', 'located', 'in'],
  ['start', 'for'], ['origin', 'at'], ['origin', 'is']
];

const DEST_MARKERS = [
  ['to'], ['towards'], ['toward'],
  ['going', 'to'], ['heading', 'to'], ['headed', 'to'], ['head', 'to'],
  ['get', 'to'], ['go', 'to'], ['need', 'to', 'reach'], ['want', 'to', 'reach'],
  ['travel', 'to'], ['travelling', 'to'], ['traveling', 'to'], ['driving', 'to'],
  ['take', 'me', 'to'], ['take', 'us', 'to'], ['way', 'to'], ['route', 'to'],
  ['path', 'to'], ['reach'], ['reaching'], ['arrive', 'at'], ['arrive', 'in'],
  ['make', 'it', 'to'], ['drop', 'me', 'at'], ['drop', 'me', 'to'],
  ['move', 'to'], ['come', 'to'], ['coming', 'to'], ['head', 'towards'],
  ['headed', 'towards'], ['heading', 'towards'], ['destination', 'is'],
  ['want', 'to', 'go'], ['need', 'to', 'go']
];

/* Phrases meaning "my current location". */
const HERE_MARKERS = [
  ['from', 'here'], ['here'], ['from', 'my', 'current', 'location'],
  ['from', 'current', 'location'], ['from', 'my', 'location'],
  ['from', 'current', 'position'], ['my', 'current', 'location'],
  ['current', 'location'], ['current', 'position'], ['my', 'location'],
  ['where', 'i', 'am'], ['where', 'i', 'm'], ['where', 'i', 'currently', 'am'],
  ['i', 'am', 'here'], ['im', 'here'], ['from', 'where', 'i', 'am']
];

/* "to" followed by these verbs is part of "want to / need to", not a place. */
const TO_VERBS = new Set([
  'go', 'going', 'gone', 'went', 'reach', 'get', 'grab', 'travel',
  'travelling', 'traveling', 'take', 'taking', 'takee', 'head', 'headed',
  'heading', 'come', 'coming', 'see', 'view', 'visit', 'meet', 'pick',
  'drop', 'fly', 'flying', 'walk', 'walking', 'drive', 'driving', 'look',
  'find', 'plan', 'see', 'buy', 'start', 'begin'
]);

/* Priority-ordered travel-mode hints. */
const MODE_TESTS = [
  ['flight', /\b(fly|flying|flight|flights|by\s*air|airplane|aeroplane|plane)\b/i],
  ['bus', /\b(bus|buses|coach|by\s*bus)\b/i],
  ['bike', /\b(bike|biking|cycling|bicycle|motorcycle|scooter|two\s*-?\s*wheeler|enfield|activa|by\s*bike)\b/i],
  ['walk', /\b(walk|walking|on\s*foot|pedestrian|by\s*walk)\b/i],
  ['car', /\b(car|cab|taxi|drive|driving|auto\s*rickshaw|rickshaw|to\s*drive)\b/i]
];

const MODE_PHRASE_RE = /\b(by|in|on|take|taking|catch|catching|ride|riding|also|to)\s+(a|an|the)?\s*(car|bus|bike|scooter|motorcycle|cycle|bicycle|flight|plane|walk|foot)\b/gi;
const MODE_TRAIL_RE = /\b(journey|mode|transport|travel|commute)\b/gi;

function normalize(t) {
  return String(t || '')
    .replace(/['’]+/g, '')
    .replace(/[.,;:!?،؛।॥…"“”«»()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isJunk(w) {
  if (!w) return true;
  const lw = String(w).toLowerCase().trim();
  if (!lw) return true;
  if (/^[0-9]+$/.test(lw)) return true;
  if (lw.length <= 1 && !/[\u0C80-\u0CFF\u0900-\u097F]/.test(lw)) return true;
  if (JUNK.has(lw)) return true;
  return false;
}

/* Single Latin initials like the "K" and "R" of "K R Market". */
function isInitial(w) {
  const lw = String(w || '').toLowerCase();
  return /^[a-z]$/.test(lw) && lw !== 'a' && lw !== 'i';
}

/* Generic words that commonly END Indian place names ("Electronic City",
   "K R Market") — keep them instead of trimming them as junk. */
const END_KEEP = new Set([
  'city', 'town', 'village', 'district', 'area', 'market', 'road', 'street',
  'layout', 'cross', 'junction', 'fort', 'palace', 'garden', 'park', 'beach',
  'station', 'airport', 'gate', 'circle', 'square', 'colony', 'nagar'
]);

function isHERE(token) {
  const lw = String(token || '').trim().toLowerCase().replace(/['’]+/g, '');
  return lw === 'here' || lw === 'currentlocation' || lw === 'currentposition';
}

function titleCaseLatin(v) {
  if (/[\u0C80-\u0CFF\u0900-\u097F]/.test(v)) return v;
  return v.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

function cleanupPlace(token) {
  const v = String(token || '').trim();
  if (!v) return null;
  if (/[\u0C80-\u0CFF\u0900-\u097F]/.test(v)) return v;
  return titleCaseLatin(v) || null;
}

/* Longest phrase (list of words) that matches starting at index i. */
function longestPhraseAt(tokens, i, phrases) {
  let best = null;
  for (const p of phrases) {
    let ok = true;
    for (let k = 0; k < p.length; k++) {
      if (tokens[i + k] !== p[k]) { ok = false; break; }
    }
    if (ok && (!best || p.length > best.length)) best = p;
  }
  return best;
}

function nextNonJunk(tokens, from) {
  for (let i = from; i < tokens.length; i++) {
    if (!isJunk(tokens[i]) && !isHERE(tokens[i])) return i;
  }
  return -1;
}

function markerAt(tokens, i) {
  const here = longestPhraseAt(tokens, i, HERE_MARKERS);
  if (here) return { role: 'origin', len: here.length, here: true };
  const o = longestPhraseAt(tokens, i, ORIGIN_MARKERS);
  if (o) return { role: 'origin', len: o.length };
  const d = longestPhraseAt(tokens, i, DEST_MARKERS);
  if (d) {
    // A bare "to" is often part of "want to go / need to"; skip it.
    if (d.length === 1 && d[0] === 'to') {
      const n = nextNonJunk(tokens, i + 1);
      if (n >= 0 && TO_VERBS.has(tokens[n])) return null;
    }
    return { role: 'dest', len: d.length };
  }
  return null;
}

function collectPlace(tokens, start) {
  let i = start;
  while (i < tokens.length && isJunk(tokens[i]) && !isHERE(tokens[i]) && !isInitial(tokens[i])) i++;
  if (i >= tokens.length) return null;
  if (isHERE(tokens[i])) return { name: HERE_TOKEN, start: i, end: i + 1 };

  const parts = [];
  let end = i;
  let seen = false;
  for (let k = i; k < tokens.length; k++) {
    if (markerAt(tokens, k)) break;
    const w = tokens[k];
    if (isJunk(w) && !isInitial(w)) {
      if (parts.length) parts.push(w);
      continue;
    }
    parts.push(w);
    end = k + 1;
    seen = true;
  }
  while (parts.length && isJunk(parts[parts.length - 1]) && !isInitial(parts[parts.length - 1]) && !END_KEEP.has(parts[parts.length - 1])) parts.pop();
  if (!parts.length || !seen) return null;
  return { name: cleanupPlace(parts.join(' ')), start: i, end };
}

/* Extract one of the travel modes, if mentioned. */
export function extractTravelMode(text) {
  const t = String(text || '').toLowerCase();
  for (const [mode, re] of MODE_TESTS) {
    if (re.test(t)) return mode;
  }
  return null;
}

/* Strip "by bus / in a car / take a flight" style fragments so they
   never get mistaken for place names. */
function stripModePhrases(text) {
  return String(text || '')
    .replace(MODE_PHRASE_RE, ' ')
    .replace(MODE_TRAIL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectCorrection(text) {
  const t = normalize(text);
  if (!t) return null;
  const mark = /\b(actually|wait|no\b|instead|rather|change|update|switch|replace|set|edit|modify|correction|make\s+it|make\s+the)\b/.test(t);
  if (!mark) return null;

  const modeM = t.match(/\b(?:make\s+it|switch\s+to|change\s+(?:to\s+|the\s+mode\s+to\s+)?|set\s+(?:it\s+)?to|use)\s*(?:a\s+|an\s+|the\s+)?(car|bus|bike|cycle|flight|plane|walk|foot|drive|driving|flying|walking)\b/);
  if (modeM) {
    const map = { drive: 'car', driving: 'car', fly: 'flight', flying: 'flight', cycle: 'bike', walking: 'walk', foot: 'walk' };
    return { field: 'mode', value: map[modeM[1]] || modeM[1] };
  }

  // "change the starting point to Tumakuru" / "make the destination Mangaluru"
  const connectorRe = '(?:to|as|is|be|at|from)?';
  const endingRe = '(?=\\s*(?:instead|please|ok|okay|thanks|and|then|\\.|$))';
  const originNew = t.match(new RegExp('\\b(?:make|set|change|update|switch|replace)?\\s*(?:the\\s+)?(?:starting\\s+point|origin|start)\\s*' + connectorRe + '\\s+([a-z][a-z\\s\']{1,44}?)' + endingRe));
  if (originNew) {
    const v = cleanupPlace(originNew[1].replace(/\s+/g, ' ').trim());
    if (v && !isJunk(v.split(' ')[0])) return { field: 'origin', value: v };
  }
  const destNew = t.match(new RegExp('\\b(?:make|set|change|update|switch|replace)?\\s*(?:the\\s+)?(?:destination|end\\s+point|end)\\s*' + connectorRe + '\\s+([a-z][a-z\\s\']{1,44}?)' + endingRe));
  if (destNew) {
    const v = cleanupPlace(destNew[1].replace(/\s+/g, ' ').trim());
    if (v && !isJunk(v.split(' ')[0])) return { field: 'destination', value: v };
  }

  // "start from X instead" / "from bengaluru instead"
  const insteadFrom = t.match(/\bfrom\s+([a-z][a-z\s']{1,44}?)\s+instead\b/);
  if (insteadFrom) {
    const v = cleanupPlace(insteadFrom[1].trim());
    if (v && !isJunk(v.split(' ')[0])) return { field: 'origin', value: v };
  }
  const insteadTo = t.match(/\b(?:take\s+me\s+to|go\s+to|to)\s+([a-z][a-z\s']{1,44}?)\s+instead\b/);
  if (insteadTo) {
    const v = cleanupPlace(insteadTo[1].trim());
    if (v && !isJunk(v.split(' ')[0])) return { field: 'destination', value: v };
  }

  // Fallback fuller phrases ("the destination should be X", "starting point is X").
  const originDesc = t.match(/\b(?:the\s+)?(?:starting\s*point|origin|start|from)\b[^.!?]{0,24}?\b(?:to|as|is|from|should\s+be)\s+([a-z][a-z\s']{1,44}?)(?=\s*(?:instead|please|and|then|\.|$))/);
  if (originDesc) {
    const v = cleanupPlace(originDesc[1].replace(/\s+/g, ' ').trim());
    if (v && !isJunk(v.split(' ')[0])) return { field: 'origin', value: v };
  }
  const destDesc = t.match(/\b(?:the\s+)?(?:destination|drop[- ]?off|end\s*point|dests)\b[^.!?]{0,24}?\b(?:to|as|is|should\s+be)\s+([a-z][a-z\s']{1,44}?)(?=\s*(?:instead|please|and|then|\.|$))/);
  if (destDesc) {
    const v = cleanupPlace(destDesc[1].replace(/\s+/g, ' ').trim());
    if (v && !isJunk(v.split(' ')[0])) return { field: 'destination', value: v };
  }

  return null;
}

/*
  Returns a structured intent:
  {
    kind: 'route' | 'origin-only' | 'dest-only' | 'single' | 'ambiguous' | 'correction' | 'none',
    origin?, destination?, place?, places?, mode?, field?, value?, confidence, raw, language
  }
*/
export function parseVoiceIntent(text, opts) {
  const raw = String(text || '');
  const base = {
    raw,
    language: 'en',
    mode: extractTravelMode(raw)
  };

  const correction = detectCorrection(raw);
  if (correction) {
    return { ...base, kind: 'correction', field: correction.field, value: correction.value, confidence: 'high' };
  }

  const cleaned = stripModePhrases(normalize(raw));
  if (!cleaned) return { ...base, kind: 'none', confidence: 'low' };

  const tokens = cleaned.split(' ');
  const used = new Array(tokens.length).fill(false);
  const originCands = [];
  const destCands = [];
  const hereCands = [];
  let markerCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    const m = markerAt(tokens, i);
    if (!m) continue;
    markerCount++;
    for (let k = 0; k < m.len; k++) used[i + k] = true;
    if (m.here) {
      hereCands.push(i);
      continue;
    }
    const got = collectPlace(tokens, i + m.len);
    if (got) {
      for (let k = got.start; k < got.end; k++) used[k] = true;
      if (got.name === HERE_TOKEN) hereCands.push(got.start);
      else if (m.role === 'origin') originCands.push(got.name);
      else destCands.push(got.name);
      i = got.end - 1;
    } else {
      i = i + m.len - 1;
    }
  }

  // Prefer the marker pair closest together: keep last origin, first dest.
  const originHere = hereCands.length > 0;
  let origin = originCands.length ? originCands[originCands.length - 1] : null;
  let dest = destCands.length ? destCands[0] : null;

  // Leftovers -> candidate place names spoken without markers.
  const leftoverNames = [];
  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    const w = tokens[i];
    if (isJunk(w) || isHERE(w)) continue;
    if (w.length < 2) continue;
    leftoverNames.push(cleanupPlace(w));
  }

  // Bare names fill whichever side is still missing
  // (covers "Bengaluru to Mysuru" and "Mysuru from Bengaluru").
  if (origin === null && !originHere && dest !== null && leftoverNames.length >= 1) {
    origin = leftoverNames.shift();
  } else if (origin !== null && dest === null && leftoverNames.length >= 1) {
    dest = leftoverNames.shift();
  } else if (originHere && dest === null && leftoverNames.length >= 1) {
    dest = leftoverNames.shift();
  }

  const hasRoute = (origin !== null || originHere) && dest !== null;
  const confidence = hasRoute
    ? (markerCount >= 2 || originHere ? 'high' : 'medium')
    : (markerCount > 0 ? 'medium' : 'low');

  if (hasRoute) {
    return {
      ...base,
      kind: 'route',
      origin: originHere ? HERE_TOKEN : origin,
      destination: dest,
      originIsHere: originHere,
      confidence
    };
  }

  if (originHere && origin === null) {
    return { ...base, kind: 'origin-only', place: HERE_TOKEN, confidence };
  }
  if (origin !== null && dest === null) {
    return { ...base, kind: 'origin-only', place: origin, confidence };
  }
  if (dest !== null && origin === null) {
    return { ...base, kind: 'dest-only', place: dest, confidence };
  }

  if (leftoverNames.length === 1) {
    return { ...base, kind: 'single', place: leftoverNames[0], confidence: 'low' };
  }
  if (leftoverNames.length === 2) {
    return { ...base, kind: 'ambiguous', places: leftoverNames, confidence: 'low' };
  }

  return { ...base, kind: 'none', confidence: 'low' };
}

/* Backwards-compatible wrapper (kept for any external callers). */
export function parseVoiceRoute(text) {
  const r = parseVoiceIntent(text);
  if (r.kind === 'route') return { type: 'route', origin: r.origin, destination: r.destination, raw: r.raw, language: 'en' };
  if (r.kind === 'single' || r.kind === 'dest-only' || r.kind === 'origin-only') {
    if (r.kind === 'origin-only' && r.place === HERE_TOKEN) return { type: 'route', origin: HERE_TOKEN, raw: r.raw, language: 'en' };
    return { type: 'single', place: r.place, raw: r.raw, language: 'en' };
  }
  if (r.kind === 'ambiguous') return { type: 'ambiguous', places: r.places, raw: r.raw, language: 'en' };
  return { type: 'none', raw: r.raw, language: 'en' };
}

export function parseCorrection(text) {
  const c = detectCorrection(text);
  if (!c) return null;
  if (c.field === 'origin') return { type: 'correction', field: 'origin', value: c.value };
  if (c.field === 'destination') return { type: 'correction', field: 'destination', value: c.value };
  return { type: 'correction', field: 'mode', value: c.value };
}

export function describeVoiceParse(parsed) {
  const parts = [`intent=${parsed.kind || parsed.type}`];
  if (parsed.origin) parts.push(`origin=${parsed.origin}`);
  if (parsed.destination) parts.push(`dest=${parsed.destination}`);
  if (parsed.place) parts.push(`place=${parsed.place}`);
  if (parsed.places) parts.push(`places=${parsed.places.join('|')}`);
  if (parsed.mode) parts.push(`mode=${parsed.mode}`);
  if (parsed.confidence) parts.push(`conf=${parsed.confidence}`);
  parts.push(`lang=${parsed.language || 'en'}`);
  return parts.join(' ');
}