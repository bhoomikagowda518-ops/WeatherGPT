const OSRM_BASE = 'https://router.project-osrm.org';

export async function getRoute(origin, destination) {
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const url = `${OSRM_BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=true`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429) {
        return { error: 'Routing service is busy. Please try again shortly.' };
      }
      return { error: 'Routing service temporarily unavailable.' };
    }

    const data = await res.json();

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      return { error: 'No route found between these locations. They may not be connected by road.' };
    }

    const routes = data.routes.map(r => ({
      geometry: r.geometry,
      distance: r.distance,
      duration: r.duration,
      legs: r.legs
    }));

    return { routes };
  } catch (err) {
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      return { error: 'Network error during routing. Check your internet connection.' };
    }
    return { error: 'Failed to calculate route. Please try again.' };
  }
}

export function getRouteCheckpoints(geometry, numCheckpoints = 5) {
  if (!geometry || !geometry.coordinates || geometry.coordinates.length < 2) {
    return [];
  }

  const coords = geometry.coordinates;
  const totalCoords = coords.length;

  if (totalCoords <= numCheckpoints) {
    return coords.map((c, i) => ({
      lng: c[0],
      lat: c[1],
      fraction: i / Math.max(totalCoords - 1, 1)
    }));
  }

  const checkpoints = [];
  for (let i = 0; i <= numCheckpoints; i++) {
    const idx = Math.round((i / numCheckpoints) * (totalCoords - 1));
    checkpoints.push({
      lng: coords[idx][0],
      lat: coords[idx][1],
      fraction: i / numCheckpoints
    });
  }

  return checkpoints;
}

export function getRouteDistanceAtFraction(geometry, fraction) {
  if (!geometry || !geometry.coordinates) return 0;
  return fraction * getRouteLength(geometry);
}

export function getRouteLength(geometry) {
  if (!geometry || !geometry.coordinates) return 0;
  let total = 0;
  const coords = geometry.coordinates;
  for (let i = 1; i < coords.length; i++) {
    total += haversine(
      coords[i - 1][1], coords[i - 1][0],
      coords[i][1], coords[i][0]
    );
  }
  return total;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

// Cumulative distance (km) at each geometry vertex.
export function getDistanceCache(geometry) {
  if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) return [0];
  const coords = geometry.coordinates;
  const cache = [0];
  for (let i = 1; i < coords.length; i++) {
    cache.push(cache[i - 1] + haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  return cache;
}

// Interpolated point at a fraction (0..1) of the route length. GeoJSON coords are [lng, lat].
export function getPointAtFraction(geometry, fraction, distanceCache) {
  const coords = geometry.coordinates;
  const cache = distanceCache || getDistanceCache(geometry);
  const totalKm = cache[cache.length - 1];
  const f = clamp01(fraction);

  if (totalKm <= 0) {
    const c = coords[0];
    return { lat: c[1], lng: c[0], segIndex: 0, segFraction: 0, fraction: f };
  }

  const targetKm = totalKm * f;
  let i = 0;
  while (i < cache.length - 2 && cache[i + 1] < targetKm) i++;
  const segLenKm = cache[i + 1] - cache[i];
  const t = segLenKm > 0 ? (targetKm - cache[i]) / segLenKm : 0;
  const a = coords[i];
  const b = coords[i + 1];
  return {
    lat: a[1] + (b[1] - a[1]) * t,
    lng: a[0] + (b[0] - a[0]) * t,
    segIndex: i,
    segFraction: clamp01(t),
    fraction: f
  };
}

// Bearing (degrees clockwise from north) between two lat/lng points.
export function bearingBetween(lat1, lng1, lat2, lng2) {
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lng2 - lng1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Nearest point on the route polyline for a given lat/lng. Returns the snapped
// point plus along-route progress. Coordinates are handled as GeoJSON [lng, lat].
export function snapPointToRoute(geometry, lat, lng) {
  const coords = geometry.coordinates;
  if (!coords || coords.length < 2) {
    return { lat, lng, segIndex: 0, segFraction: 0, alongM: 0, totalM: 0, fraction: 0, distanceFromRouteM: 0 };
  }

  let bestDistSq = Infinity;
  let best = { px: lng, py: lat, segIndex: 0, t: 0 };

  for (let i = 0; i < coords.length - 1; i++) {
    const ax = coords[i][0];
    const ay = coords[i][1];
    const bx = coords[i + 1][0];
    const by = coords[i + 1][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? ((lng - ax) * dx + (lat - ay) * dy) / len2 : 0;
    const tc = clamp01(t);
    const px = ax + dx * tc;
    const py = ay + dy * tc;
    const d2 = (lng - px) * (lng - px) + (lat - py) * (lat - py);
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      best = { px, py, segIndex: i, t: tc };
    }
  }

  const cache = getDistanceCache(geometry);
  const totalM = cache[cache.length - 1] * 1000;
  const segStartM = cache[best.segIndex] * 1000;
  const segLenM = (cache[best.segIndex + 1] - cache[best.segIndex]) * 1000;
  const alongM = segStartM + best.t * segLenM;

  return {
    lat: best.py,
    lng: best.px,
    segIndex: best.segIndex,
    segFraction: best.t,
    alongM,
    totalM,
    fraction: totalM > 0 ? clamp01(alongM / totalM) : 0,
    distanceFromRouteM: bestDistSq <= 0 ? 0 : haversine(lat, lng, best.py, best.px) * 1000
  };
}

// Bearing from the current route position toward the NEXT geometry point in the
// direction of travel (never a straight-line bearing to the destination).
export function nextSegmentBearing(geometry, snapped) {
  const coords = geometry.coordinates;
  const i = snapped.segIndex;
  if (i < coords.length - 1) {
    return bearingBetween(snapped.lat, snapped.lng, coords[i + 1][1], coords[i + 1][0]);
  }
  return bearingBetween(coords[Math.max(i - 1, 0)][1], coords[Math.max(i - 1, 0)][0], snapped.lat, snapped.lng);
}
