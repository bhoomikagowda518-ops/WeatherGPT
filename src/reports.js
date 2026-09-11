import { getConditionFromCode } from './weather.js';

/* =====================================================================
 * Weather Impact Reports
 *
 * A source-of-truth model for "weather impact reports" around a journey:
 * mostly official warnings pulled from the IMD District Warnings service,
 * with route relevance, temporal freshness, source credibility, forecast
 * agreement and severity composed into one inspectable relevance score.
 *
 * Hard rules honoured here:
 *  - NO generic news feed. Only weather-impact signals are shown.
 *  - Every report carries an evidence_tier and status_type; we never claim
 *    "observed"/"confirmed" for a warning — it is always a forecast for a
 *    potential impact unless independently verified.
 *  - No fabricated reports. If the official feed is unreachable or empty,
 *    the caller gets an explicit state, not invented content.
 *  - No hardcoded gazetteer. Location comes from the source geometries
 *    (district polygons) and Nominatim reverse geocoding of centroids.
 *  - Route distance is measured to the route GEOMETRY, never as a
 *    straight line between two cities.
 *  - Privacy: only the route's coarse bounding box is sent to the warning
 *    service; precise GPS never leaves the browser.
 * ===================================================================== */

const WFS_PROXY = '/imdwfs';
const WFS_LAYER = 'imd:district_warnings_india';
const SOURCE_NAME = 'India Meteorological Department (IMD)';
const SOURCE_URL = 'https://mausam.imd.gov.in/responsive/districtWiseWarningGIS.php';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

const ROUTE_SAMPLE_MAX = 160;
const RELEVANCE_RADIUS_KM = 150;
const CACHE_TTL_MS = 10 * 60 * 1000;

/* ------------- IMD district warning decode tables ------------- */

const IMD_WARNING_CODES = {
  1: 'No Warning',
  2: 'Heavy Rain',
  3: 'Heavy Snow',
  4: 'Thunderstorm & Lightning',
  5: 'Hailstorm',
  6: 'Dust Storm',
  7: 'Dust Raising Winds',
  8: 'Strong Surface Winds',
  9: 'Heat Wave',
  10: 'Hot Day',
  11: 'Warm Night',
  12: 'Cold Wave',
  13: 'Cold Day',
  14: 'Ground Frost',
  15: 'Fog',
  16: 'Very Heavy Rain',
  17: 'Extremely Heavy Rain'
};

// IMD color codes for district warnings: 1=Red (worst) ... 4=Green (none)
const IMD_COLORS = {
  1: { label: 'Red', hex: '#dc2626', severity: 'severe', emoji: '🔴' },
  2: { label: 'Orange', hex: '#f97316', severity: 'high', emoji: '🟠' },
  3: { label: 'Yellow', hex: '#facc15', severity: 'moderate', emoji: '🟡' },
  4: { label: 'Green', hex: '#22c55e', severity: 'low', emoji: '🟢' }
};

const EVENT_META = {
  THUNDERSTORM: { emoji: '⛈️', impact: 'Reduced visibility, lightning risk and sudden downpour can make driving hazardous. Add buffer time and avoid stopping under trees.' },
  HEAVY_RAIN: { emoji: '🌧️', impact: 'Heavy rain can flood low-lying stretches and reduce visibility. Keep a slower speed and watch for standing water.' },
  VERY_HEAVY_RAIN: { emoji: '🌧️', impact: 'Very heavy rain risks water-logging and route closures. Expect slower travel; consider an alternate route.' },
  EXTREME_RAIN: { emoji: '🌊', impact: 'Extreme rainfall can cause flash flooding. Reconsider travel unless it is essential.' },
  SNOW: { emoji: '❄️', impact: 'Snow can make mountain roads slippery and sometimes closed. Carry winter gear and check conditions.' },
  HAIL: { emoji: '🧊', impact: 'Hail can damage vehicles and reduce traction. Seek cover if hail begins.' },
  DUST_STORM: { emoji: '🌪️', impact: 'Dust storms cut visibility sharply. Slow down, use headlights and keep safe distance.' },
  STRONG_WIND: { emoji: '💨', impact: 'Gusty winds make two-wheelers and high-sided vehicles harder to control. Reduce speed.' },
  HEATWAVE: { emoji: '🥵', impact: 'Extreme heat can cause tyre issues and driver fatigue. Carry water and rest often.' },
  HOT_DAY: { emoji: '🌡️', impact: 'Hot conditions can affect vehicle cooling and occupant comfort. Plan hydration stops.' },
  WARM_NIGHT: { emoji: '🌙', impact: 'Warm night may cause poor rest; plan adequate breaks on long journeys.' },
  COLD_WAVE: { emoji: '🥶', impact: 'Cold-wave temperatures can freeze roads briefly. Dress warm and check for icy patches.' },
  COLD_DAY: { emoji: '🧊', impact: 'Cold conditions may reduce tyre grip on damp surfaces.' },
  FROST: { emoji: '🌫️', impact: 'Ground frost can make early-morning roads slippery.' },
  FOG: { emoji: '🌫️', impact: 'Dense fog greatly reduces visibility. Use fog lamps and slow down.' }
};

const CODE_TO_EVENT = {
  2: 'HEAVY_RAIN', 3: 'SNOW', 4: 'THUNDERSTORM', 5: 'HAIL', 6: 'DUST_STORM',
  7: 'DUST_STORM', 8: 'STRONG_WIND', 9: 'HEATWAVE', 10: 'HOT_DAY',
  11: 'WARM_NIGHT', 12: 'COLD_WAVE', 13: 'COLD_DAY', 14: 'FROST', 15: 'FOG',
  16: 'VERY_HEAVY_RAIN', 17: 'EXTREME_RAIN'
};

const SEVERITY_WEIGHT = { severe: 1.0, high: 0.8, moderate: 0.55, low: 0.25 };
const CREDIBILITY = {
  official_warning: 1.0,
  verified_report: 0.8,
  news_report: 0.6,
  public_unverified: 0.3,
  unknown: 0.2
};

/* ------------- small geometry helpers ------------- */

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/* Sample the route polyline into evenly indexed points (GeoJSON [lng,lat]). */
function sampleRoutePoints(geometry, n) {
  const coords = geometry && geometry.coordinates;
  if (!coords || coords.length < 2) return [];
  const step = Math.max(1, Math.floor(coords.length / Math.max(n, 40)));
  const pts = [];
  for (let i = 0; i < coords.length; i += step) {
    pts.push({ lat: coords[i][1], lng: coords[i][0], fraction: i / (coords.length - 1) });
  }
  if (pts[pts.length - 1].lat !== coords[coords.length - 1][1]) {
    const i = coords.length - 1;
    pts.push({ lat: coords[i][1], lng: coords[i][0], fraction: 1 });
  }
  return pts;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* Flatten MultiPolygon/Polygon geometry into rings for containment checks. */
function collectRings(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function ringExtent(ring) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const c of ring) {
    if (c[0] < minLon) minLon = c[0];
    if (c[0] > maxLon) maxLon = c[0];
    if (c[1] < minLat) minLat = c[1];
    if (c[1] > maxLat) maxLat = c[1];
  }
  return { minLon, maxLon, minLat, maxLat };
}

function ringCentroid(ring) {
  let lat = 0, lng = 0;
  for (const c of ring) { lat += c[1]; lng += c[0]; }
  return { lat: lat / ring.length, lng: lng / ring.length };
}

/* Ray-casting point-in-polygon for a ring (handles [lng,lat] pairs). */
function ringContains(ring, lat, lng) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/* ------------- warning normalization ------------- */

function parseDayCell(cell) {
  let raw = String(cell || '').trim();
  if (!raw || raw === '0' || raw === '1') return [];
  return raw.split(',').map(s => parseInt(s, 10)).filter(n => n > 1);
}

function buildReportFromFeature(feature) {
  const p = feature.properties || {};
  const rings = collectRings(feature.geometry);
  const extents = rings.map(ringExtent).filter(e => e.minLon !== Infinity);

  const dayCells = [1, 2, 3, 4, 5].map(d => ({ codes: parseDayCell(p[`Day_${d}`]), color: p[`Day${d}_Color`] }));
  const activeDays = dayCells
    .map((d, i) => ({ day: i + 1, codes: d.codes, colors: d.color }))
    .filter(d => d.codes.length > 0);

  if (activeDays.length === 0) return null;

  const issueDate = new Date(`${p.Date}T18:00:00+05:30`); // IMD bulletins end-of-day local
  const maxSeverity = activeDays.reduce((m, d) => {
    const s = IMD_COLORS[d.colors]?.severity || 'low';
    return SEVERITY_WEIGHT[s] > SEVERITY_WEIGHT[m] ? s : m;
  }, 'low');

  const displayDays = activeDays.map(d => ({
    day: d.day,
    codes: d.codes,
    labels: d.codes.map(c => IMD_WARNING_CODES[c] || `Code ${c}`),
    events: d.codes.map(c => CODE_TO_EVENT[c]).filter(Boolean),
    color: IMD_COLORS[d.colors] || IMD_COLORS[4],
    date: isoDate(addDays(issueDate, d.day - 1))
  }));

  const allEvents = [...new Set(displayDays.flatMap(d => d.events))];
  const primaryEvent = allEvents[0] || 'THUNDERSTORM';

  const bbox = {
    minLat: Math.min(...extents.map(e => e.minLat)),
    maxLat: Math.max(...extents.map(e => e.maxLat)),
    minLon: Math.min(...extents.map(e => e.minLon)),
    maxLon: Math.max(...extents.map(e => e.maxLon))
  };
  const centroid = ringCentroid(extents[0]);

  return {
    id: `imd-${p.Obj_id}`,
    source_id: String(p.Obj_id),
    source_name: SOURCE_NAME,
    source_url: SOURCE_URL,
    title: displayDays[0].labels.join(' & '),
    summary: buildSummary(displayDays, p.District, maxSeverity),
    event_type: primaryEvent,
    events: allEvents,
    evidence_tier: 'official_warning',
    status_type: 'forecast',
    location: String(p.District || 'Unknown district').toUpperCase(),
    district: String(p.District || '').toUpperCase(),
    state: '',
    coords: centroid,
    bbox,
    ringRepresentative: extents[0].slice(0, 4 <= extents[0].length ? 200 : extents[0].length),
    published_at: issueDate.toISOString(),
    ingested_at: new Date().toISOString(),
    severity: maxSeverity,
    severity_color: IMD_COLORS[maxSeverity === 'severe' ? 1 : maxSeverity === 'high' ? 2 : maxSeverity === 'moderate' ? 3 : 4].hex,
    emoji: EVENT_META[primaryEvent]?.emoji || '⚠️',
    days: displayDays,
    impact: EVENT_META[primaryEvent]?.impact || '',
    raw: { obj_id: p.Obj_id, date: p.Date, district: p.District },
    route: null,
    score: null
  };
}

function buildSummary(days, district, severity) {
  const times = days.slice(0, 3).map(d => `Day ${d.day} (${d.date})`).join(', ');
  const more = days.length > 3 ? ` +${days.length - 3} more` : '';
  return `IMD ${severity}-level district warning for ${district}. ${days[0].labels.join(', ')}. Active ${times}${more} (forecast window).`;
}

/* ------------- data fetch (with caching) ------------- */

let wfsCache = { key: null, fetchedAt: 0, features: [] };

async function fetchJSON(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function roundKey(v) {
  return Math.round(v * 10) / 10;
}

async function fetchDistrictWarnings(bbox) {
  const key = `${roundKey(bbox.minLat)},${roundKey(bbox.minLon)},${roundKey(bbox.maxLat)},${roundKey(bbox.maxLon)}`;
  const now = Date.now();
  if (wfsCache.key === key && now - wfsCache.fetchedAt < CACHE_TTL_MS) {
    return { ok: true, features: wfsCache.features, cached: true };
  }

  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: WFS_LAYER,
    outputFormat: 'application/json',
    count: '400',
    bbox: `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon},urn:ogc:def:crs:EPSG:4326`
  });

  // 1) dev proxy (CORS-safe). 2) direct fallback (works when a host proxy / CORS header exists).
  let data = null;
  try {
    data = await fetchJSON(`${WFS_PROXY}/wfs?${params}`, 14000);
  } catch (_err) {
    try {
      data = await fetchJSON(`https://reactjs.imd.gov.in/geoserver/wfs?${params}`, 14000);
    } catch (_ignored) {
      return { ok: false, features: [] };
    }
  }

  const features = (data && data.features) || [];
  wfsCache = { key, fetchedAt: Date.now(), features };
  return { ok: true, features, cached: false };
}

/* ------------- route relevance ------------- */

function matchReportToRoute(report, samples, routeKm) {
  const rings = [report.ringRepresentative];
  let minDist = Infinity;
  let nearestFraction = 0;
  let insideCount = 0;

  for (const p of samples) {
    const inPoly = rings.some(r => ringContains(r, p.lat, p.lng));
    let d;
    if (inPoly) {
      d = 0;
      insideCount++;
    } else {
      d = haversineKm(p.lat, p.lng, report.coords.lat, report.coords.lng);
    }
    if (d < minDist) { minDist = d; nearestFraction = p.fraction; }
  }

  const insideRatio = insideCount / Math.max(samples.length, 1);
  const relevant = insideRatio > 0 || minDist <= RELEVANCE_RADIUS_KM;

  report.route = {
    minDistanceKm: Math.round(minDist * 10) / 10,
    insideRatio: Math.round(insideRatio * 100) / 100,
    fractionAtNearest: Math.round(nearestFraction * 1000) / 1000,
    relevant,
    routeKm
  };
  return report;
}

/* ------------- forecast agreement (cross-check, never "false") ------------- */

function routeForecastSignal(checkpoints) {
  let maxPrecipProb = 0, worstCode = 0, maxWind = 0, minVis = Infinity, maxTemp = -Infinity;
  for (const cp of checkpoints) {
    const w = cp && cp.weather;
    if (!w || w.error) continue;
    if (w.hourly?.[0]?.precipitationProbability != null) maxPrecipProb = Math.max(maxPrecipProb, w.hourly[0].precipitationProbability);
    if (w.weatherCode != null) worstCode = Math.max(worstCode, w.weatherCode);
    if (w.windSpeed != null) maxWind = Math.max(maxWind, w.windSpeed);
    if (w.visibility != null) minVis = Math.min(minVis, w.visibility);
    if (w.temperature != null) maxTemp = Math.max(maxTemp, w.temperature);
  }
  return { maxPrecipProb, worstCode, maxWind, minVis, maxTemp };
}

function computeForecastAgreement(report, signal) {
  const ev = report.events || [report.event_type];
  let matched = null;
  let desc = '';

  if (ev.includes('THUNDERSTORM')) {
    matched = signal.worstCode >= 95 || signal.maxPrecipProb >= 60;
    desc = matched ? `forecast shows storms along this area (⛈️, ${Math.round(signal.maxPrecipProb)}% rain)` : 'forecast here is relatively calm';
  } else if (ev.includes('HEAVY_RAIN') || ev.includes('VERY_HEAVY_RAIN') || ev.includes('EXTREME_RAIN')) {
    matched = signal.maxPrecipProb >= 70 || (signal.worstCode >= 61 && signal.worstCode <= 67);
    desc = matched ? `forecast shows heavy rain probabilities near ${Math.round(signal.maxPrecipProb)}%` : 'hourly forecast does not strongly confirm heavy rain';
  } else if (ev.includes('STRONG_WIND') || ev.includes('DUST_STORM')) {
    matched = signal.maxWind >= 40;
    desc = matched ? `forecast winds reach ~${Math.round(signal.maxWind)} km/h` : `forecast winds are ~${Math.round(signal.maxWind) || 0} km/h`;
  } else if (ev.includes('FOG')) {
    matched = signal.minVis <= 2500;
    desc = matched ? `forecast visibility as low as ${Math.round(signal.minVis)} m` : 'forecast visibility is better than the warning implies';
  } else if (ev.includes('HEATWAVE') || ev.includes('HOT_DAY') || ev.includes('WARM_NIGHT')) {
    matched = signal.maxTemp >= 38;
    desc = matched ? `forecast temperatures near ${Math.round(signal.maxTemp)}°C` : `forecast temperatures around ${Math.round(signal.maxTemp) || 0}°C`;
  } else if (ev.includes('COLD_WAVE') || ev.includes('COLD_DAY') || ev.includes('FROST')) {
    matched = signal.maxTemp <= 12;
    desc = matched ? `forecast temperatures near ${Math.round(signal.maxTemp) || 0}°C` : `forecast temperatures around ${Math.round(signal.maxTemp) || 0}°C`;
  } else if (ev.includes('SNOW')) {
    matched = signal.worstCode >= 71;
    desc = matched ? `forecast shows snowfall (${getConditionFromCode(signal.worstCode)})` : 'forecast does not clearly show snowfall';
  } else if (ev.includes('HAIL')) {
    matched = signal.worstCode === 96 || signal.worstCode === 99;
    desc = matched ? 'forecast shows possible hail' : 'forecast does not clearly indicate hail';
  }

  const forecastAvailable = signal.maxTemp > -Infinity || signal.maxPrecipProb > 0 || signal.worstCode > 0;
  if (!forecastAvailable) {
    return { score: 0.5, label: 'independent forecast unavailable — treat the official warning seriously', matched: null };
  }
  if (matched == null) {
    return { score: 0.5, label: 'forecast signal not strongly correlated', matched: null };
  }
  return {
    score: matched ? 1.0 : 0.25,
    label: matched ? desc : `${desc} — this only means "not confirmed", never that the warning is wrong`,
    matched
  };
}

/* ------------- scoring ------------- */

function scoreReport(report, opts) {
  const r = report.route;
  const parts = {};
  const explanation = [];

  const scalarInside = r.insideRatio > 0 ? 1 : clamp01(1 - r.minDistanceKm / RELEVANCE_RADIUS_KM);
  parts.geographic_proximity = Math.round(clamp01(0.6 * (r.insideRatio > 0 ? r.insideRatio : 0) + 0.4 * scalarInside) * 100) / 100;
  explanation.push(r.insideRatio > 0
    ? `${Math.round(r.insideRatio * 100)}% of your route track falls inside ${report.district} district`
    : `route passes ~${r.minDistanceKm} km from ${report.district} district`);

  const ageHours = Math.max(0, (Date.now() - new Date(report.published_at).getTime()) / 3600e3);
  const firstActiveDay = report.days[0]?.day || 1;
  parts.temporal_freshness = Math.round(clamp01(Math.exp(-ageHours / 30) * (1 - (firstActiveDay - 1) * 0.2)) * 100) / 100;
  explanation.push(`warning posted ${ageHours < 1 ? 'under an hour' : Math.round(ageHours) + 'h'} ago, active from Day ${firstActiveDay}`);

  parts.source_credibility = Math.round(CREDIBILITY[report.evidence_tier] * 100) / 100;
  explanation.push(`${report.evidence_tier.replace('_', ' ')}: official IMD district bulletin`);

  parts.weather_forecast_agreement = opts.agreement.score;
  explanation.push(`cross-check: ${opts.agreement.label}`);

  parts.severity = SEVERITY_WEIGHT[report.severity];
  explanation.push(`${report.severity}-level (${IMD_COLORS[report.severity === 'severe' ? 1 : report.severity === 'high' ? 2 : report.severity === 'moderate' ? 3 : 4].label}) color rating from IMD`);

  report.score = {
    total: Math.round(
      (0.35 * parts.geographic_proximity +
        0.20 * parts.temporal_freshness +
        0.15 * parts.source_credibility +
        0.15 * parts.weather_forecast_agreement +
        0.15 * parts.severity) * 1000
    ) / 1000,
    weights: { geographic_proximity: 0.35, temporal_freshness: 0.20, source_credibility: 0.15, weather_forecast_agreement: 0.15, severity: 0.15 },
    parts,
    explanation
  };
  return report;
}

/* ------------- state name (best effort, cached, bounded) ------------- */

const stateCache = {};
let stateQueueTail = Promise.resolve();

async function attachState(report) {
  if (report.state) return report;
  const cacheKey = report.district;
  if (stateCache[cacheKey]) { report.state = stateCache[cacheKey]; return report; }

  const lat = report.coords.lat, lng = report.coords.lng;
  stateQueueTail = stateQueueTail.then(() => requestState(lat, lng, cacheKey)).then((s) => {
    report.state = s || '';
    stateCache[cacheKey] = s || '';
  }).catch(() => {});
  await stateQueueTail;
  return report;
}

async function requestState(lat, lng, cacheKey) {
  try {
    const params = new URLSearchParams({
      lat: lat.toString(),
      lon: lng.toString(),
      format: 'json',
      zoom: '8',
      addressdetails: '1'
    });
    const res = await fetch(`${NOMINATIM_REVERSE_URL}?${params}`, {
      headers: { 'User-Agent': 'WeatherGPT-RouteIntelligence/1.0' }
    });
    if (!res.ok) return '';
    const data = await res.json();
    const state = data?.address?.state || data?.address?.province || '';
    if (state) return String(state);
    if (data?.display_name) return data.display_name.split(',').slice(-2, -1)[0] || '';
    return '';
  } catch {
    return '';
  }
}

/* ------------- main entry ------------- */

export async function buildReportAnalysis(ctx) {
  const geometry = ctx.geometry;
  if (!geometry || !geometry.coordinates || geometry.coordinates.length < 2) {
    return { state: 'no_route', reports: [], error: 'No route geometry to match reports against.' };
  }

  const samples = sampleRoutePoints(geometry, ROUTE_SAMPLE_MAX);
  if (samples.length === 0) return { state: 'no_route', reports: [] };

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of samples) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lng); maxLon = Math.max(maxLon, p.lng);
  }
  const PAD = 0.5;
  const bbox = {
    minLat: Math.max(-89, minLat - PAD),
    maxLat: Math.min(89, maxLat + PAD),
    minLon: Math.max(-179, minLon - PAD),
    maxLon: Math.min(179, maxLon + PAD)
  };

  const fetched = await fetchDistrictWarnings(bbox);
  if (!fetched.ok) {
    return { state: 'source_unavailable', reports: [], error: 'The official IMD district-warning feed did not respond.' };
  }

  const reports = [];
  for (const feature of fetched.features) {
    const rep = buildReportFromFeature(feature);
    if (rep) reports.push(rep);
  }

  if (reports.length === 0) {
    return {
      state: 'empty', reports: [], fetchedAt: new Date().toISOString(), cached: fetched.cached,
      info: 'No active IMD district warnings intersect the area around your route.'
    };
  }

  const matched = reports
    .map(r => matchReportToRoute(r, samples, ctx.routeKmTotal || 0))
    .filter(r => r.route.relevant);

  if (matched.length === 0) {
    return {
      state: 'empty', reports: [], fetchedAt: new Date().toISOString(), cached: fetched.cached,
      info: `No official warnings within ${RELEVANCE_RADIUS_KM} km of your route right now.`
    };
  }

  matched.sort((a, b) => a.route.minDistanceKm - b.route.minDistanceKm);
  const forScoring = matched.slice(0, 10);

  const signal = routeForecastSignal(ctx.checkpoints || []);
  for (const report of forScoring) {
    scoreReport(report, { agreement: computeForecastAgreement(report, signal) });
    await attachState(report);
  }

  matched.sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0));

  return {
    state: 'ok',
    reports: matched.slice(0, 6),
    fetchedAt: new Date().toISOString(),
    cached: fetched.cached,
    routeKmTotal: ctx.routeKmTotal || 0,
    signal: signalSummary(signal),
    debug: {
      bbox, cacheHit: fetched.cached, fetchedFeatures: fetched.features.length,
      candidateReports: matched.length
    }
  };
}

function signalSummary(signal) {
  return {
    maxPrecipProb: Math.round(signal.maxPrecipProb || 0),
    worstCode: signal.worstCode,
    condition: getConditionFromCode(signal.worstCode || null),
    maxWind: Math.round(signal.maxWind || 0),
    minVis: signal.minVis === Infinity ? null : Math.round(signal.minVis),
    maxTemp: signal.maxTemp === -Infinity ? null : Math.round(signal.maxTemp)
  };
}

// Re-score already-fetched reports against a new checkpoint forecast set
// (e.g. when the user slides the departure time). No network involved.
export function rescoreReports(analysis, checkpoints) {
  if (!analysis || !analysis.reports) return analysis;
  const signal = routeForecastSignal(checkpoints || []);
  analysis.signal = signalSummary(signal);
  for (const report of analysis.reports) {
    scoreReport(report, { agreement: computeForecastAgreement(report, signal) });
  }
  analysis.reports.sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0));
  return analysis;
}

export function formatAge(publishedAt) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(publishedAt).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatReportLocation(report) {
  const st = report.state ? `, ${report.state}` : '';
  return `${report.district}${st}`;
}

export function liveReportOffset(report, liveFraction, routeKm) {
  if (liveFraction == null || routeKm <= 0) return null;
  const diffKm = (report.route.fractionAtNearest - liveFraction) * routeKm;
  const ahead = diffKm >= 0;
  return { ahead, km: Math.abs(diffKm) };
}

export { IMD_WARNING_CODES, IMD_COLORS, RELEVANCE_RADIUS_KM };