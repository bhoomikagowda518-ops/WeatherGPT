import { getRoute, getPointAtFraction } from './routing.js';
import { getWeatherForPoint, applyArrivalForecast } from './weather.js';
import { reverseGeocode } from './geocoding.js';

const SCHEMA_VERSION = '1.0';

const SEVERITY_THRESHOLDS = {
  precip_mm_h: [2.5, 7.5, 35],
  wind_km_h: [30, 50, 65],
  visibility_km: [5, 2, 1]
};

const MODE_MODIFIER = {
  walk: { fragile: true, escalates_adverse: true, escalates_reduced: true, note: 'Walking is fully exposed to weather the entire way.' },
  bike: { fragile: true, escalates_adverse: true, escalates_reduced: true, note: 'Two-wheelers are more sensitive to wind, rain and low visibility.' },
  transit: { fragile: false, escalates_adverse: false, escalates_reduced: false, note: 'Most leg is sheltered; exposure mostly at stops and transfers.' },
  drive: { fragile: false, escalates_adverse: false, escalates_reduced: false, note: 'Enclosed vehicle with direct road exposure.' },
  flight: { fragile: false, escalates_adverse: false, escalates_reduced: false, note: 'Ground-level weather applies mainly at airports.' }
};

const DECISION_EMOJI = {
  GOOD_TO_GO: '\u{1F7E2}',
  CAUTION: '\u{1F7E1}',
  HIGH_IMPACT: '\u{1F7E0}',
  SEVERE: '\u{1F534}',
  INSUFFICIENT_DATA: '\u26AA'
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function makeQueryId() {
  return `qp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function severityOfMetric(name, value) {
  const b = SEVERITY_THRESHOLDS[name];
  if (name === 'visibility_km') {
    if (value >= b[0]) return 'NORMAL';
    if (value >= b[1]) return 'REDUCED';
    if (value >= b[2]) return 'ADVERSE';
    return 'SEVERE';
  }
  if (value < b[0]) return 'NORMAL';
  if (value < b[1]) return 'REDUCED';
  if (value <= b[2]) return 'ADVERSE';
  return 'SEVERE';
}

const SEV_ORDER = { NORMAL: 0, REDUCED: 1, ADVERSE: 2, SEVERE: 3, UNKNOWN: 4 };

function classifyCheckpoint(weather) {
  if (!weather || weather.error) {
    return { severity: 'UNKNOWN', reason: 'Weather data unavailable.', raw: null, metric_severities: {} };
  }

  const raw = {
    precip_mm_h: weather.precipitation,
    wind_km_h: weather.windSpeed,
    visibility_km: weather.visibility != null ? weather.visibility / 1000 : null
  };

  const metric_severities = {};
  let worst = 'NORMAL';
  let worstMetricKey = null;
  for (const key of ['precip_mm_h', 'wind_km_h', 'visibility_km']) {
    if (raw[key] == null) continue;
    const sev = severityOfMetric(key, raw[key]);
    metric_severities[key] = sev;
    if (SEV_ORDER[sev] > SEV_ORDER[worst]) {
      worst = sev;
      worstMetricKey = key;
    }
  }

  if (Object.keys(metric_severities).length === 0) {
    return { severity: 'UNKNOWN', reason: 'No measurable weather metrics.', raw, metric_severities: {} };
  }

  return {
    severity: worst,
    reason: worst === 'NORMAL'
      ? 'All metrics within normal thresholds.'
      : `Worst metric: ${worstMetricKey} \u2192 ${worst}.`,
    raw,
    metric_severities,
    worst_metric_key: worstMetricKey
  };
}

function formatMetric(key, value) {
  if (value == null) return 'n/a';
  if (key === 'precip_mm_h') return `${value.toFixed(1)} mm/h`;
  if (key === 'wind_km_h') return `${Math.round(value)} km/h`;
  if (key === 'visibility_km') return `${value.toFixed(1)} km`;
  return String(value);
}

function planCheckpoints(distanceM) {
  const km = Math.max(distanceM || 0, 0.01) / 1000;
  let segments;
  if (km < 20) segments = 2;
  else if (km < 50) segments = 3;
  else if (km < 120) segments = 5;
  else if (km < 300) segments = 7;
  else segments = 9;
  const fractions = [];
  for (let i = 0; i <= segments; i++) fractions.push(i / segments);
  return fractions.map((frac) => ({
    fraction: frac,
    distance_km: +(km * frac).toFixed(2),
    is_start: frac === 0,
    is_end: frac === 1
  }));
}

const nameCache = new Map();

async function loadPlaceName(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (nameCache.has(key)) return nameCache.get(key);
  let name = null;
  try { name = await reverseGeocode(lat, lng); } catch { name = null; }
  name = name && name.trim() ? name.trim() : null;
  nameCache.set(key, name);
  return name;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function batchParallel(items, fn, limit, batchDelayMs) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map((item, j) => fn(item, i + j)));
    chunkResults.forEach((r, j) => { results[i + j] = r; });
    if (i + limit < items.length) await sleep(batchDelayMs);
  }
  return results;
}

function normalizePlace(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function placesOverlap(a, b) {
  if (!a || !b) return false;
  const na = normalizePlace(a);
  const nb = normalizePlace(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

async function attachCheckpointNames(checkpoints, originName, destinationName) {
  const loaded = await batchParallel(checkpoints, async (cp) => {
    if (cp.is_start) return { ...cp, place_name: originName };
    if (cp.is_end) return { ...cp, place_name: destinationName };
    const name = await loadPlaceName(cp.lat, cp.lng);
    return { ...cp, place_name: name };
  }, 5, 20);

  const originNorm = normalizePlace(originName);
  const destNorm = normalizePlace(destinationName);
  const seen = new Set([originNorm, destNorm]);
  const result = [];

  for (const cp of loaded) {
    if (cp.is_start || cp.is_end) {
      result.push(cp);
      continue;
    }
    const name = cp.place_name;
    const norm = normalizePlace(name);
    if (!name || placesOverlap(name, destinationName) || placesOverlap(name, originName) || seen.has(norm)) {
      result.push({ ...cp, place_name: 'Route segment' });
    } else {
      seen.add(norm);
      result.push(cp);
    }
  }
  return result;
}

function computeExposure(checkpoints, totalKm, travelMode) {
  const n = checkpoints.length;
  if (n === 0) {
    return {
      total_km: +totalKm.toFixed(1),
      severe_km: 0, adverse_km: 0, reduced_km: 0, unavailable_km: 0,
      exposed_to_adverse_percent: 0, exposed_to_reduced_percent: 0,
      unavailable_percent: 0, max_severity: 'UNKNOWN'
    };
  }

  const weights = [];
  for (let i = 0; i < n; i++) {
    const prevBound = i === 0 ? 0 : (checkpoints[i - 1].fraction + checkpoints[i].fraction) / 2;
    const nextBound = i === n - 1 ? 1 : (checkpoints[i].fraction + checkpoints[i + 1].fraction) / 2;
    weights.push(Math.max(0, nextBound - prevBound));
  }

  let severeKm = 0, adverseKm = 0, reducedKm = 0, unavailableKm = 0, availableKm = 0;
  let maxSeverity = 'NORMAL';
  let maxSevFound = false;

  checkpoints.forEach((cp, i) => {
    const w = weights[i] * totalKm;
    const s = cp.segment_severity.severity;
    if (s === 'UNKNOWN') { unavailableKm += w; return; }
    availableKm += w;
    if (s === 'SEVERE') severeKm += w;
    if (SEV_ORDER[s] >= SEV_ORDER.ADVERSE) adverseKm += w;
    if (SEV_ORDER[s] >= SEV_ORDER.REDUCED) reducedKm += w;
    if (!maxSevFound || SEV_ORDER[s] > SEV_ORDER[maxSeverity]) { maxSeverity = s; maxSevFound = true; }
  });

  const total = Math.max(totalKm, 0.001);
  return {
    total_km: +totalKm.toFixed(1),
    available_km: +availableKm.toFixed(1),
    severe_km: +severeKm.toFixed(1),
    adverse_km: +adverseKm.toFixed(1),
    reduced_km: +reducedKm.toFixed(1),
    unavailable_km: +unavailableKm.toFixed(1),
    exposed_to_adverse_percent: +((adverseKm / total) * 100).toFixed(1),
    exposed_to_reduced_percent: +((reducedKm / total) * 100).toFixed(1),
    unavailable_percent: +((unavailableKm / total) * 100).toFixed(1),
    max_severity: maxSevFound ? maxSeverity : 'UNKNOWN',
    mode: travelMode
  };
}

function recommend({ exposure, travelMode, totalKm }) {
  const modifier = MODE_MODIFIER[travelMode] || MODE_MODIFIER.drive;
  const max = exposure.max_severity;
  const adversePct = exposure.exposed_to_adverse_percent;
  const reducedPct = exposure.exposed_to_reduced_percent;
  const unavailPct = exposure.unavailable_percent;
  const frag = modifier.fragile;

  let label;
  let trigger = '';

  if (max === 'SEVERE') {
    label = 'SEVERE';
    trigger = 'At least one checkpoint is rated SEVERE.';
  } else if (unavailPct > 30) {
    label = 'INSUFFICIENT_DATA';
    trigger = `Weather unavailable on ${unavailPct.toFixed(0)}% of the route (> 30%).`;
  } else if (max === 'ADVERSE') {
    if (frag || adversePct > 25) {
      label = 'HIGH_IMPACT';
      trigger = `${adversePct.toFixed(0)}% of route km exposed to ADVERSE or worse.`;
    } else {
      label = 'CAUTION';
      trigger = `ADVERSE conditions present but on ${adversePct.toFixed(0)}% of the route.`;
    }
  } else if (max === 'REDUCED') {
    if (frag || reducedPct > 40) {
      label = 'CAUTION';
      trigger = `${reducedPct.toFixed(0)}% of route km exposed to REDUCED or worse.`;
    } else {
      label = 'GOOD_TO_GO';
      trigger = `REDUCED conditions only on ${reducedPct.toFixed(0)}% of the route.`;
    }
  } else if (max === 'NORMAL') {
    label = 'GOOD_TO_GO';
    trigger = 'All checkpoints within NORMAL severity thresholds.';
  } else {
    label = 'INSUFFICIENT_DATA';
    trigger = 'No usable weather measurements for this route.';
  }

  return {
    label,
    emoji: DECISION_EMOJI[label],
    headline: headlineFor(label, exposure, travelMode, totalKm),
    key_insight: keyInsightFor(label, exposure, travelMode, totalKm, modifier),
    decision_rationale: `Decision matrix v${SCHEMA_VERSION} | max_severity=${max} | adverse_km=${exposure.adverse_km} (${adversePct}%) | reduced_km=${exposure.reduced_km} (${reducedPct}%) | unavailable=${unavailPct}% | mode=${travelMode} | ${trigger} => ${label}`,
    mode_modifier: { mode: travelMode, fragile: frag, applied: frag ? 'escalates exposure' : 'none', note: modifier.note },
    trigger
  };
}

function headlineFor(label) {
  switch (label) {
    case 'SEVERE': return 'Severe weather conditions on this route.';
    case 'HIGH_IMPACT': return 'High-impact weather on this route \u2014 plan carefully.';
    case 'CAUTION': return 'Caution advised \u2014 some challenging weather ahead.';
    case 'INSUFFICIENT_DATA': return 'Limited weather data \u2014 exercise caution.';
    default: return 'Good to go \u2014 weather is manageable.';
  }
}

function keyInsightFor(label, exposure, travelMode, totalKm, modifier) {
  const total = Math.max(totalKm, 0.001);
  switch (label) {
    case 'SEVERE':
      return `Route passes through SEVERE conditions (${exposure.severe_km} km, ${((exposure.severe_km / total) * 100).toFixed(0)}% of the journey). Consider delaying or choosing an alternate route.`;
    case 'HIGH_IMPACT':
      return `${exposure.exposed_to_adverse_percent.toFixed(0)}% of the route (${exposure.adverse_km} km) faces ADVERSE or worse weather. ${modifier.note}`;
    case 'CAUTION':
      return `Some stretches (${exposure.exposed_to_reduced_percent.toFixed(0)}% of km) will see REDUCED or worse weather${modifier.fragile ? '; exposure matters more for this mode' : ''}.`;
    case 'INSUFFICIENT_DATA':
      return `Weather coverage is incomplete (${exposure.unavailable_percent.toFixed(0)}% unavailable). Forecasts may miss conditions forming later along the route.`;
    default:
      return `All checked segments are within normal thresholds. Weather should not meaningfully affect the journey.`;
  }
}

function hazardDescription(feature, sev) {
  if (feature === 'Precipitation') {
    if (sev === 'SEVERE' || sev === 'ADVERSE') return 'Heavy rainfall may increase the risk of temporary water accumulation in low-lying areas. Wet surfaces can reduce grip and visibility.';
    return 'Moderate rainfall may make surfaces wet and reduce visibility slightly.';
  }
  if (feature === 'Wind') {
    if (sev === 'SEVERE' || sev === 'ADVERSE') return 'Strong winds may reduce stability, especially for two-wheelers and high-sided vehicles.';
    return 'Moderately strong winds may affect handling, particularly for bikes and motorbikes.';
  }
  if (feature === 'Visibility') {
    if (sev === 'SEVERE') return 'Very low visibility can make navigation and hazard detection harder.';
    return 'Reduced visibility may make hazards harder to spot in time.';
  }
  return 'Weather conditions along this segment warrant attention.';
}

function featureFor(key) {
  if (key === 'precip_mm_h') return { feature: 'Precipitation', metric: 'precip_mm_h' };
  if (key === 'wind_km_h') return { feature: 'Wind', metric: 'wind_km_h' };
  if (key === 'visibility_km') return { feature: 'Visibility', metric: 'visibility_km' };
  return null;
}

function buildHazards(checkpoints) {
  const hazards = [];
  checkpoints.forEach((cp, i) => {
    const cls = cp.segment_severity;
    if (cls.severity === 'UNKNOWN') return;
    const w = cp.weather || {};
    const arrival = w.arrivalTime ? new Date(w.arrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'forecast window';

    if (w.weatherCode != null && w.weatherCode >= 95) {
      hazards.push({
        severity: 'SEVERE', checkpoint_index: i, place_name: cp.place_name,
        feature: 'Thunderstorm', value: `weather code ${w.weatherCode}`,
        description: 'Thunderstorms can bring sudden heavy rain, lightning and strong gusts.',
        evidence_source: `Open-Meteo forecast at ${cp.place_name} (arrival ${arrival}) \u2014 weather_code = ${w.weatherCode}`
      });
      return;
    }

    for (const key of ['precip_mm_h', 'wind_km_h', 'visibility_km']) {
      const msev = cls.metric_severities[key];
      if (!msev || SEV_ORDER[msev] < SEV_ORDER.REDUCED) continue;
      const meta = featureFor(key);
      if (!meta) continue;
      hazards.push({
        severity: msev, checkpoint_index: i, place_name: cp.place_name,
        distance_km: cp.distance_km, feature: meta.feature, metric: meta.metric,
        value: formatMetric(key, cls.raw[key]),
        description: hazardDescription(meta.feature, msev),
        evidence_source: `Open-Meteo forecast at ${cp.place_name} (arrival ${arrival}) \u2014 ${meta.metric} = ${formatMetric(key, cls.raw[key])}`
      });
    }
  });
  return hazards.sort((a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity]);
}

export function reevalRecommendation(analysis, travelMode) {
  const totalKm = analysis.route.distance_km;
  const exposure = computeExposure(analysis.checkpoints, totalKm, travelMode);
  const recommendation = recommend({ exposure, travelMode, totalKm });
  return {
    ...analysis,
    resolution: { ...analysis.resolution, travel_mode: travelMode },
    exposure,
    recommendation,
    explanation: {
      decision_rationale: recommendation.decision_rationale,
      headline_source: 'decision matrix v1.0',
      decision_emoji: recommendation.emoji
    }
  };
}

// Client-side re-evaluation for a different departure time. Reuses the cached
// hourly forecast captured during the original analysis so the route can recolor
// instantly while dragging the departure slider (no network needed).
export function recomputeForDeparture(checkpoints, totalKm, durationS, travelMode, departureTime) {
  const depMs = new Date(departureTime).getTime();
  const fresh = (checkpoints || []).map((cp) => {
    if (!cp.hourlyForecast || cp.hourlyForecast.length === 0) return cp;
    const arrivalMs = depMs + (cp.fraction || 0) * durationS * 1000;
    const w = applyArrivalForecast({ hourly: cp.hourlyForecast }, new Date(arrivalMs));
    return { ...cp, weather: w, segment_severity: classifyCheckpoint(w) };
  });
  const km = totalKm || 0;
  const mode = travelMode && MODE_MODIFIER[travelMode] ? travelMode : 'drive';
  const exposure = computeExposure(fresh, km, mode);
  const recommendation = recommend({ exposure, travelMode: mode, totalKm: km });
  return { checkpoints: fresh, exposure, recommendation };
}

export async function runJourneyAnalysis({ origin, destination, travelMode, departureTime, onStatus, routeIndex }) {
  const t0 = Date.now();
  const pipeline = [];
  const stamp = (stage) => pipeline.push({ stage, ms: Date.now() - t0 });
  const status = (msg) => { if (onStatus) onStatus(msg); };

  const mode = travelMode && MODE_MODIFIER[travelMode] ? travelMode : 'drive';
  const depDt = departureTime ? new Date(departureTime) : new Date();
  const depMs = depDt.getTime();

  status('Calculating route...');
  const routeResult = await getRoute(origin, destination);
  if (routeResult.error) return { error: routeResult.error };
  stamp('route');

  const primary = routeResult.routes[routeIndex] || routeResult.routes[0];
  const plans = planCheckpoints(primary.distance);
  const kms = primary.distance / 1000;
  const geom = primary.geometry;
  const osrmDuration = primary.duration;

  status('Placing checkpoints along the route...');
  const geoPoints = plans.map((p, i) => {
    const pt = getPointAtFraction(geom, p.fraction);
    return { ...p, index: i, lat: pt.lat, lng: pt.lng };
  });
  stamp('checkpoints');

  status('Naming places on the route...');
  const named = await attachCheckpointNames(
    geoPoints,
    origin.shortName || origin.name || 'Start',
    destination.shortName || destination.name || 'Destination'
  );
  stamp('place_names');

  status('Sampling weather at arrival times...');
  const withWeather = await batchParallel(named, async (cp) => {
    const arrivalMs = depMs + (cp.fraction || 0) * osrmDuration * 1000;
    const rawWeather = await getWeatherForPoint(cp.lat, cp.lng);
    const resultWeather = rawWeather && !rawWeather.error
      ? applyArrivalForecast(rawWeather, new Date(arrivalMs))
      : rawWeather;
    return {
      ...cp,
      weather: resultWeather,
      hourlyForecast: (rawWeather && !rawWeather.error && rawWeather.hourly) ? rawWeather.hourly : null
    };
  }, 5, 20);
  stamp('weather');

  status('Classifying segment severity...');
  const checkpoints = withWeather.map((cp) => ({
    ...cp,
    segment_severity: classifyCheckpoint(cp.weather)
  }));
  stamp('severity');

  stamp('exposure');
  const exposure = computeExposure(checkpoints, kms, mode);

  const recommendation = recommend({ exposure, travelMode: mode, totalKm: kms });
  stamp('decision');

  const hazards = buildHazards(checkpoints);
  stamp('hazards');

  const checkpointsWithWeather = checkpoints.filter((c) => c.segment_severity.severity !== 'UNKNOWN').length;
  const checkpointsUnavailable = checkpoints.length - checkpointsWithWeather;

  return {
    schema_version: SCHEMA_VERSION,
    query_id: makeQueryId(),
    generated_at: new Date().toISOString(),
    resolution: {
      origin: { name: origin.shortName || origin.name || null, lat: origin.lat, lng: origin.lng },
      destination: { name: destination.shortName || destination.name || null, lat: destination.lat, lng: destination.lng },
      travel_mode: mode,
      departure_time: depDt.toISOString(),
      route_service: 'OSRM',
      weather_service: 'Open-Meteo'
    },
    route: {
      distance_km: +kms.toFixed(2),
      distance_m: primary.distance,
      duration_s: osrmDuration,
      service: 'OSRM',
      geometry: geom,
      primary_route: primary,
      selected_route_index: routeIndex || 0,
      available_routes: routeResult.routes.length
    },
    checkpoints,
    exposure,
    recommendation,
    explanation: {
      decision_rationale: recommendation.decision_rationale,
      headline_source: 'decision matrix v1.0',
      decision_emoji: recommendation.emoji
    },
    hazards,
    data_quality: {
      checkpoints_total: checkpoints.length,
      checkpoints_with_weather: checkpointsWithWeather,
      checkpoints_unavailable: checkpointsUnavailable,
      unavailable_percentage: exposure.unavailable_percent
    },
    debug: {
      schema_version: SCHEMA_VERSION,
      route_profile: 'driving (OSRM public)',
      route_duration_note: mode !== 'drive'
        ? `OSRM provides a driving profile. The duration shown is a driving ETA. Mode "${mode}" affects weather impact interpretation only.`
        : undefined,
      pipeline,
      re_pipelines: []
    }
  };
}