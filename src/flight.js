const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const DEFAULT_RADIUS_M = 250000;

function buildQuery(lat, lng, radiusM) {
  return `[out:json][timeout:25];(
  node["aerodrome"](around:${radiusM},${lat},${lng});
  way["aerodrome"](around:${radiusM},${lat},${lng});
);out center 60;`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Real airport lookup around a point using OpenStreetMap aerodrome data.
 * Returns the nearest public airports (or nearest aerodromes if none is tagged
 * public). Never guessed or hardcoded — empty array if nothing is found.
 */
export async function findNearestAirports(lat, lng, { radiusM = DEFAULT_RADIUS_M, limit = 2 } = {}) {
  if (lat == null || lng == null) return [];

  try {
    const query = buildQuery(lat, lng, radiusM);
    const res = await fetch(`${OVERPASS_URL}?data=${encodeURIComponent(query)}`);
    if (!res.ok) return [];

    const data = await res.json();
    const elements = data && data.elements ? data.elements : [];

    const airports = elements
      .map((el) => {
        const point = el.type === 'node' ? el : el.center;
        if (!point || point.lat == null || point.lon == null) return null;
        const tags = el.tags || {};
        const name = String(tags['name:en'] || tags.name || 'Airport').trim();
        const isPublic = !tags.aerodrome || /public|military/.test(String(tags.aerodrome));
        return {
          name: name === 'Airport' && el.id ? `${name} ${el.id}` : name,
          lat: point.lat,
          lng: point.lon,
          isPublic,
          id: el.id
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const da = haversineKm(lat, lng, a.lat, a.lng);
        const db = haversineKm(lat, lng, b.lat, b.lng);
        return (Number(b.isPublic) - Number(a.isPublic)) || (da - db);
      });

    return airports.slice(0, limit);
  } catch {
    return [];
  }
}

export function greatCircleKm(from, to) {
  if (!from || !to || from.lat == null || to.lat == null) return 0;
  return haversineKm(from.lat, from.lng, to.lat, to.lng);
}

/**
 * Rough flying-time estimate derived from the real great-circle distance between
 * two airports (cruise ~800 km/h plus climb/descent allowance). An estimate only,
 * never a real schedule.
 */
export function estimateFlightMinutes(distanceKm) {
  if (distanceKm <= 0) return 0;
  return Math.max(30, Math.round((distanceKm / 800) * 60 + 20));
}