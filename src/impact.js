export const MODES = {
  car: { label: 'Car', icon: '🚗', factor: 0.8, exposureWord: 'mostly shielded' },
  bike: { label: 'Bike', icon: '🏍️', factor: 1.15, exposureWord: 'fully exposed' },
  bus: { label: 'Bus', icon: '🚌', factor: 0.7, exposureWord: 'mostly sheltered' },
  walk: { label: 'Walk', icon: '🚶', factor: 1.3, exposureWord: 'fully exposed' },
  flight: { label: 'Flight', icon: '✈️', factor: 1, exposureWord: 'weather-dependent' }
};

export const IMPACT_EMOJI = { low: '🟢', moderate: '🟡', high: '🟠', severe: '🔴' };

const RANK = { low: 0, moderate: 1, high: 2, severe: 3 };

const EFFECTIVE_MODES = new Set(['bike', 'walk']);

export function classifyWeather(w) {
  if (!w || w.error) return { bucket: 'unknown', severity: 0 };
  let bucket = 'clear';
  let severity = 0;

  const code = w.weatherCode;
  if (code != null) {
    if (code >= 95) { bucket = 'storm'; severity = 5; }
    else if (code >= 65 && code <= 67 || code === 82) { bucket = 'heavyRain'; severity = 4; }
    else if (code === 81 || code >= 61 && code <= 63) { bucket = 'rain'; severity = 3; }
    else if (code >= 80) { bucket = 'showers'; severity = 2; }
    else if (code >= 71 && code <= 77 || code >= 85 && code <= 86) { bucket = 'snow'; severity = 4; }
    else if (code >= 51 && code <= 57) { bucket = 'drizzle'; severity = 1; }
    else if (code >= 45 && code <= 48) { bucket = 'fog'; severity = 2; }
    else { bucket = 'clear'; severity = 0; }
  }

  if (w.windSpeed != null && w.windSpeed > 60) { bucket = 'wind'; severity = Math.max(severity, 4); }
  else if (w.windSpeed != null && w.windSpeed > 40) { bucket = 'wind'; severity = Math.max(severity, 3); }

  if (w.visibility != null && w.visibility < 500) severity = Math.max(severity, 4);
  else if (w.visibility != null && w.visibility < 2000 && bucket !== 'fog') severity = Math.max(severity, 2);

  if (w.temperature != null && w.temperature > 42) { bucket = 'heat'; severity = Math.max(severity, 4); }
  else if (w.temperature != null && w.temperature > 38) { bucket = 'heat'; severity = Math.max(severity, 3); }

  if (w.temperature != null && w.temperature < -5) { bucket = 'cold'; severity = Math.max(severity, 3); }

  return { bucket, severity };
}

export function evaluateModeImpacts(mode, w) {
  if (!w || w.error) return [];
  const s = classifyWeather(w);
  if (mode === 'flight') return evaluateFlightImpacts(w, s);
  const impacts = [];
  const add = (level, text) => impacts.push({ level, text });

  switch (s.bucket) {
    case 'storm':
      if (mode === 'bike' || mode === 'walk') add('severe', 'Thunderstorm with lightning — exposed on the road');
      else add('moderate', 'Storm cells along the route — allow extra time and reduce speed');
      break;
    case 'heavyRain':
      if (mode === 'bike' || mode === 'walk') add('severe', 'Heavy rain — soaking and slippery conditions');
      else add('moderate', 'Heavy rain reduces grip and visibility');
      break;
    case 'rain':
      if (mode === 'bike') add('moderate', 'Rain on the bike — carry protection, roads will be slick');
      else if (mode === 'walk') add('moderate', 'Rain expected — take an umbrella or rain wear');
      else add('low', 'Light rain along the road');
      break;
    case 'showers':
      if (mode === 'bike') add('moderate', 'Scattered showers — keep waterproofs handy');
      else if (mode === 'walk') add('moderate', 'Shower spells — keep cover close');
      else add('low', 'A few passing showers');
      break;
    case 'drizzle':
      add('low', 'Light drizzle — roads slightly slick');
      break;
    case 'snow':
      if (mode === 'bike' || mode === 'walk') add('severe', 'Snow and near-freezing cold — dress warmly, watch footing');
      else add('high', 'Snow on the road — traction and timing affected');
      break;
    case 'fog':
      if (mode === 'car' || mode === 'bike') add('high', 'Low visibility in fog — use lights and slow down');
      else if (mode === 'bus') add('moderate', 'Fog may slow the service');
      else add('low', 'Foggy patches, visibility reduced');
      break;
    case 'wind':
      if (mode === 'bike') add('severe', 'Strong crosswinds can destabilise a bike');
      else if (mode === 'walk') add('moderate', 'Strong gusts make walking harder');
      else add('low', 'Wind gusts — keep a steady pace');
      break;
    case 'heat':
      if (mode === 'bike' || mode === 'walk') add('severe', 'Extreme heat — risk of heat stress, stay hydrated');
      else if (mode === 'car') add('moderate', 'Interior will heat up — cooling recommended');
      else add('low', 'Hot stops — keep water with you');
      break;
    case 'cold':
      if (mode === 'bike') add('severe', 'Near-freezing cold — dress warmly against the ride');
      else if (mode === 'walk') add('high', 'Cold and breezy — layer up');
      else add('low', 'Cold conditions — minimal impact');
      break;
    case 'clear':
      break;
    default:
      break;
  }

  return impacts;
}

function evaluateFlightImpacts(w, s) {
  const impacts = [];
  const add = (level, text) => impacts.push({ level, text });

  switch (s.bucket) {
    case 'storm':
      add('high', 'Thunderstorm activity can delay or divert flights');
      break;
    case 'fog':
      add('high', 'Low visibility can delay departures and landings');
      break;
    case 'wind':
      add('high', 'Strong or cross winds can affect takeoff and landing');
      break;
    case 'snow':
      add('high', 'Snow and de-icing can slow airport operations');
      break;
    case 'heavyRain':
      add('moderate', 'Heavy rain reduces visibility for the flight crew');
      break;
    case 'showers':
      add('moderate', 'Showers may cause brief holding or taxiing delays');
      break;
    case 'rain':
      add('low', 'Rain may cause minor departure delays');
      break;
    case 'drizzle':
      add('low', 'Light drizzle — minimal impact');
      break;
    case 'heat':
      add('moderate', 'High temperatures can reduce aircraft performance');
      break;
    case 'cold':
      add('low', 'Cold conditions — expect possible runway icing');
      break;
    default:
      break;
  }

  if (w.visibility != null && w.visibility < 1000) {
    add('high', 'Visibility below 1 km is marginal for landing');
  } else if (w.visibility != null && w.visibility < 3000) {
    add('moderate', 'Reduced visibility may stretch approach times');
  }

  return impacts;
}

export function getFlightDecision({ departure, arrival, estFlightMin }) {
  const scoreFor = (place) => {
    const w = place && place.weather;
    if (!w || w.error) return { level: 'unknown', reasons: [] };
    const reasons = [];
    let score = 0;

    const code = w.weatherCode;
    if (code != null && code >= 95) {
      score = Math.max(score, 3);
      reasons.push(w.condition || 'Thunderstorm activity');
    } else if (code != null && code >= 65 && code <= 67) {
      score = Math.max(score, 2);
      reasons.push(w.condition || 'Heavy rain');
    }

    if (w.windSpeed != null) {
      const kts = w.windSpeed / 1.852;
      if (kts >= 25) {
        score = Math.max(score, 2);
        reasons.push(`wind ${Math.round(w.windSpeed)} km/h`);
      } else if (kts >= 17) {
        score = Math.max(score, 1);
        reasons.push(`wind ${Math.round(w.windSpeed)} km/h`);
      }
    }

    if (w.visibility != null) {
      if (w.visibility < 1000) {
        score = Math.max(score, 3);
        reasons.push(`visibility ${Math.round(w.visibility)} m`);
      } else if (w.visibility < 3000) {
        score = Math.max(score, 1);
        reasons.push('reduced visibility');
      }
    }

    const level = score >= 3 ? 'severe' : score === 2 ? 'high' : score === 1 ? 'moderate' : 'low';
    return { level, reasons };
  };

  const dep = scoreFor(departure);
  const arr = scoreFor(arrival);

  let level = 'go';
  const anySevere = dep.level === 'severe' || arr.level === 'severe';
  const anyHigh = dep.level === 'high' || arr.level === 'high';
  const anyModerate = dep.level === 'moderate' || arr.level === 'moderate';
  const anyUnknown = dep.level === 'unknown' || arr.level === 'unknown';

  if (anyUnknown) level = 'caution';
  else if (anySevere) level = 'avoid';
  else if (anyHigh) level = 'delay';
  else if (anyModerate) level = 'caution';

  const labels = { go: 'Good to go', caution: 'Consider caution', delay: 'Consider delaying', avoid: 'Avoid flying now' };
  const emojis = { go: '🟢', caution: '🟡', delay: '🟠', avoid: '🔴' };

  const depName = (departure && departure.name) || 'departure airport';
  const arrName = (arrival && arrival.name) || 'arrival airport';

  const parts = [];
  if (dep.reasons.length) parts.push(`Dep ${depName}: ${dep.reasons.join(', ')}`);
  if (arr.reasons.length) parts.push(`Arr ${arrName}: ${arr.reasons.join(', ')}`);
  const detail = parts.length ? parts.join(' · ') : 'Conditions look clear at both airports.';

  let message;
  if (level === 'avoid') {
    message = `Severe weather is expected — ${detail}. Delays or cancellations are likely, so travelling another time would be safest.`;
  } else if (level === 'delay') {
    message = `Challenging conditions are expected — ${detail}. If the trip is flexible, a later departure may help.`;
  } else if (level === 'caution') {
    message = anyUnknown
      ? 'Forecast data is limited at one of the airports — plan with a little extra buffer.'
      : `Mostly workable — ${detail}, so keep an eye on the forecast before heading out.`;
  } else {
    message = `Clear conditions at departure and arrival${estFlightMin > 0 ? ` for the estimated ${estFlightMin}-minute flight` : ''}.`;
  }

  return {
    level,
    emoji: emojis[level],
    title: labels[level],
    message,
    detail,
    departure: dep,
    arrival: arr
  };
}

export function computeWeatherExposure(checkpoints, risk, route, mode) {
  const totalKm = route && route.distance ? route.distance / 1000 : 0;
  const totalMin = route && route.duration ? route.duration / 60 : 0;

  let affectedKm = 0;
  let moderateKm = 0;
  const segs = risk && risk.segments ? risk.segments : [];

  for (let i = 0; i < Math.min(checkpoints.length - 1, segs.length); i++) {
    const from = checkpoints[i]?.fraction ?? 0;
    const to = checkpoints[i + 1]?.fraction ?? 1;
    const km = Math.max(0, to - from) * totalKm;
    const lvl = segs[i]?.level || 'unknown';
    if (lvl === 'high' || lvl === 'severe') affectedKm += km;
    else if (lvl === 'moderate') moderateKm += km;
  }

  const affectedPct = totalKm > 0 ? (affectedKm / totalKm) * 100 : 0;
  const exposedMin = totalKm > 0 ? (affectedKm / totalKm) * totalMin : 0;

  const meta = MODES[mode] || MODES.car;
  const effPct = Math.min(100, affectedPct * meta.factor);

  let level = 'clear';
  if (effPct >= 55) level = 'extreme';
  else if (effPct >= 30) level = 'heavy';
  else if (effPct >= 12) level = 'moderate';
  else if (effPct > 0) level = 'light';

  const aKm = round1(affectedKm);
  let transition = '';
  if (affectedPct === 0) {
    const extra = moderateKm > 0 ? ` A few stretches have reduced conditions (${round1(moderateKm)} km).` : '';
    transition = `No major adverse weather on your ${meta.label.toLowerCase()} route${extra}`;
  } else if (affectedPct < 15) {
    transition = `Brief patches of adverse weather (${aKm} km) — manageable for a ${meta.label.toLowerCase()}`;
  } else if (affectedPct < 35) {
    transition = `${aKm} km of the route faces challenging weather — you are ${meta.exposureWord}`;
  } else if (affectedPct < 60) {
    transition = `Nearly half your ${meta.label.toLowerCase()} journey passes through adverse weather — ${meta.exposureWord}`;
  } else {
    transition = `Most of this ${meta.label.toLowerCase()} journey sits in adverse conditions — ${meta.exposureWord}`;
  }

  return {
    totalKm,
    affectedKm: aKm,
    affectedPct: Math.round(affectedPct),
    moderateKm: round1(moderateKm),
    exposedMin: Math.round(exposedMin),
    level,
    interpretation: transition
  };
}

export function getWeatherTransitions(checkpoints, mode, opts = {}) {
  const totalKm = opts.totalKm || 0;
  const transitions = [];

  for (let i = 0; i < checkpoints.length - 1; i++) {
    const a = classifyWeather(checkpoints[i]?.weather);
    const b = classifyWeather(checkpoints[i + 1]?.weather);
    if (!a || !b || a.bucket === 'unknown' || b.bucket === 'unknown') continue;

    const jump = b.severity - a.severity;
    const changed = a.bucket !== b.bucket || Math.abs(jump) >= 2;
    if (!changed) continue;

    const next = checkpoints[i + 1];
    const km = Math.round((next.fraction || 0) * totalKm);
    const name = next && next.name && next.name !== 'Route segment' ? next.name : (km > 0 ? `${km} km in` : '');
    const worsening = b.severity >= a.severity;
    const loc = name ? ` near ${name}` : ' along the route';
    const exposure = worsening && b.severity >= 4 && EFFECTIVE_MODES.has(mode) ? ' — fully exposed outdoors' : '';
    const text = buildTransitionText(a.bucket, b.bucket, loc, worsening) + exposure;

    transitions.push({ atIndex: i + 1, text, severity: b.severity, worsening });
  }

  transitions.sort((x, y) => y.severity - x.severity);
  return transitions.slice(0, 4);
}

function buildTransitionText(aBucket, bBucket, loc, worsening) {
  let main;
  if (worsening) {
    switch (bBucket) {
      case 'storm': main = 'Storm activity starts'; break;
      case 'heavyRain': main = 'Heavy rain sets in'; break;
      case 'rain': main = 'Rain develops'; break;
      case 'showers': main = 'Shower spells begin'; break;
      case 'drizzle': main = 'Drizzle starts'; break;
      case 'snow': main = 'Snow begins'; break;
      case 'fog': main = 'Visibility drops'; break;
      case 'wind': main = 'Winds strengthen'; break;
      case 'heat': main = 'Heat starts to build'; break;
      case 'cold': main = 'Temperatures fall'; break;
      default: main = 'Conditions turn adverse'; break;
    }
  } else {
    switch (bBucket) {
      case 'clear': main = 'Weather clears'; break;
      case 'rain':
      case 'heavyRain': main = 'Rain eases'; break;
      case 'storm': main = 'Storms settle'; break;
      case 'fog': main = 'Fog lifts'; break;
      case 'showers': main = 'Showers ease'; break;
      case 'drizzle': main = 'Drizzle stops'; break;
      case 'snow': main = 'Snow tapers off'; break;
      case 'wind': main = 'Winds ease'; break;
      case 'heat': main = 'Heat moderates'; break;
      case 'cold': main = 'Temperatures recover'; break;
      default: main = 'Conditions ease'; break;
    }
  }
  return `${main}${loc}`;
}

export function getJourneyDecision({ risk, exposure, transitions, mode }) {
  const meta = MODES[mode] || MODES.car;
  const label = (meta.label || 'journey').toLowerCase();
  const levelLabel = risk && risk.level ? risk.level : 'unknown';

  let level = 'go';
  if (levelLabel === 'severe') {
    level = 'avoid';
  } else if (levelLabel === 'high') {
    level = exposure && exposure.affectedPct < 20 ? 'caution' : 'delay';
  } else if (levelLabel === 'moderate') {
    level = EFFECTIVE_MODES.has(mode) && exposure && exposure.affectedPct > 30 ? 'delay' : 'caution';
  } else if (levelLabel === 'unknown') {
    level = 'caution';
  } else {
    level = 'go';
  }

  const titles = {
    go: 'Good to go',
    caution: 'Consider caution',
    delay: 'Consider delaying',
    avoid: 'Avoid travelling now'
  };

  let message;
  if (level === 'avoid') {
    message = `Severe conditions are expected on part of your ${label} journey${exposure && exposure.affectedKm > 0 ? ` — ${exposure.affectedKm} km of the route faces dangerous weather` : ''}. Travelling another time would be safest.`;
  } else if (level === 'delay') {
    message = `${exposure ? exposure.affectedPct + '%' : 'A sizeable part'} of this route faces challenging weather for a ${label}. If the trip can wait, a delay may be worthwhile.`;
  } else if (level === 'caution') {
    message = `Most of the route is workable, but ${exposure && exposure.affectedKm > 0 ? exposure.affectedKm + ' km has weather that needs care' : 'parts of it need watching'} for a ${label}.`;
  } else {
    message = `Conditions look favourable for a ${label} journey today.`;
  }

  const emojis = { go: '🟢', caution: '🟡', delay: '🟠', avoid: '🔴' };

  return {
    level,
    emoji: emojis[level],
    title: titles[level],
    message
  };
}

export function summarizeModeImpacts(checkpoints) {
  const byKey = new Map();
  for (const cp of checkpoints) {
    for (const imp of (cp.impacts || [])) {
      const prev = byKey.get(imp.text);
      if (!prev || RANK[imp.level] > RANK[prev.level]) byKey.set(imp.text, imp);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => RANK[b.level] - RANK[a.level]);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}