import { reverseGeocode } from './geocoding.js';
import { getPointAtFraction } from './routing.js';

const reverseCache = new Map();
const REVERSE_DELAY_MS = 400;

const QUALITY_BAD = /(unnamed|unclassified|residential|service|road|highway|expressway|national|state\s+highway|toll|flyover|bridge|underpass)/i;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function reverseCached(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  return { get: () => reverseCache.get(key), set: (v) => reverseCache.set(key, v) };
}

function isGoodPlaceName(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (n.length < 2) return false;
  const lower = n.toLowerCase();
  if (QUALITY_BAD.test(lower)) return false;
  if (/^[\d.\/\\-]+$/.test(n)) return false;
  return true;
}

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

async function loadPlaceName(lat, lng) {
  const entry = reverseCached(lat, lng);
  if (entry.get() !== undefined) return entry.get();
  let name = null;
  try {
    name = await reverseGeocode(lat, lng);
  } catch {
    name = null;
  }
  await sleep(REVERSE_DELAY_MS);
  entry.set(name || null);
  return name || null;
}

/**
 * Discover 1-6 meaningful real geographic places that actually lie along the
 * calculated route geometry, in travel order. Never hardcoded, fully dynamic.
 */
export async function discoverCheckpoints({ geometry, startName, endName, totalDistanceM }) {
  if (!geometry || !geometry.coordinates || geometry.coordinates.length < 2) return [];

  const coords = geometry.coordinates;
  const totalKm = (totalDistanceM || 0) / 1000;

  const targetCount = totalKm < 25 ? 1 : totalKm < 60 ? 2 : totalKm < 140 ? 3 : totalKm < 280 ? 4 : 5;

  const start = {
    name: startName || 'Start',
    lat: coords[0][1],
    lng: coords[0][0],
    fraction: 0,
    isStart: true,
    isEnd: false
  };

  const end = {
    name: endName || 'Destination',
    lat: coords[coords.length - 1][1],
    lng: coords[coords.length - 1][0],
    fraction: 1,
    isStart: false,
    isEnd: true
  };

  const startNorm = normalizeName(startName);
  const endNorm = normalizeName(endName);

  // Offset attempts for each candidate slot: stay on target first, then nudge forward/back.
  const attempts = [
    [0],
    [0.06],
    [-0.06],
    [0.12],
    [-0.12]
  ];

  const middle = [];
  let lastAccepted = null;

  for (let k = 1; k <= targetCount; k++) {
    const base = k / (targetCount + 1);
    let accepted = null;
    let fallback = null;

    for (const [off] of attempts) {
      const frac = base + off;
      if (frac <= 0.025 || frac >= 0.975) continue;

      const pt = getPointAtFraction(geometry, frac);
      const name = await loadPlaceName(pt.lat, pt.lng);
      const good = isGoodPlaceName(name);
      const norm = normalizeName(name);

      if (good && norm !== startNorm && norm !== endNorm &&
          !(lastAccepted && norm === normalizeName(lastAccepted.name)) &&
          !middle.some(m => m.name && normalizeName(m.name) === norm)) {
        accepted = { ...pt, name, fraction: frac, isStart: false, isEnd: false };
        break;
      }

      if (fallback === null) {
        fallback = { ...pt, name: null, fraction: base, isStart: false, isEnd: false };
      }
    }

    if (accepted) {
      middle.push(accepted);
      lastAccepted = accepted;
    } else if (fallback && (!lastAccepted || Math.abs(fallback.fraction - lastAccepted.fraction) >= 0.06)) {
      middle.push(fallback);
      lastAccepted = fallback;
    }
  }

  // If a genuinely long route produced no named waypoints, insert one honest segment marker.
  if (middle.length === 0 && targetCount >= 1 && totalKm > 20) {
    const pt = getPointAtFraction(geometry, 0.5);
    middle.push({ ...pt, name: null, fraction: 0.5, isStart: false, isEnd: false });
  }

  return [start, ...middle, end];
}