import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { getDistanceCache } from './routing.js';
import { getWeatherForPlaces } from './weather.js';
import { triggerSevereAlert, supportsVibration, onAlert, simulateSevereAlert } from './vibration.js';
import { runJourneyAnalysis, reevalRecommendation, recomputeForDeparture } from './journey.js';
import { LiveTracker } from './tracking.js';
import { LocationAutocomplete, resolveLocationText, selectionDisplay, reverseGeocode } from './locationSearch.js';
import { parseVoiceIntent, VOICE_LANGS, HERE_TOKEN } from './voice.js';
import { createSTTSession, getSTTSetup } from './stt.js';
import { findNearestAirports, greatCircleKm, estimateFlightMinutes } from './flight.js';
import {
  MODES,
  IMPACT_EMOJI,
  getWeatherTransitions,
  getFlightDecision
} from './impact.js';

let map = null;
let currentRoute = null;
let currentRouteWeather = null;
let currentRisk = null;
let currentAnalysis = null;
let currentFlight = null;
let isAnalyzing = false;
let voiceSession = null;
let voiceState = 'idle';
let voiceSessionId = 0;
let selectedTimelineIndex = null;
let alertLog = [];
let vibrationDebugEl = null;

let travelMode = null;
let departureTime = null;
let departureShiftHours = 0;
let altIndex = 0;
let altCount = 1;
let travelContext = null;

let originAuto = null;
let destAuto = null;
let voiceCtx = null;
let voiceToastTimer = null;

let currentLocation = null;
let currentLocationToken = 0;
let currentOriginMode = 'search';
let restartTimer = null;
let analysisVersion = 0;
let voiceAmbiguousPlaces = null;

let developerMode = false;

let liveTracker = null;
let liveMode = false;
let lastLiveRenderIdx = -1;
let routeSegmentsDrawn = false;
let weatherPinMarkers = [];
let timelineSheetOpen = false;

const OSM_STYLE = {
  version: 8,
  sources: {
    'osm': {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
      ],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxzoom: 19
    }
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));

document.addEventListener('DOMContentLoaded', init);

function init() {
  renderApp();
  setupLocationSearch();
  initMap();
  liveTracker = new LiveTracker();
  liveTracker.setMap(map);
  liveTracker.onStatus = handleLiveStatus;
  setupTrackingInteractions();
  setupVoiceRecognition();
  setupAlertSystem();
  setupDeveloperMode();
}

function setupDeveloperMode() {
  const logo = document.querySelector('.header-logo');
  if (!logo) return;
  let clicks = 0;
  let timer = null;
  logo.style.cursor = 'pointer';
  logo.addEventListener('click', () => {
    clicks++;
    clearTimeout(timer);
    timer = setTimeout(() => { clicks = 0; }, 500);
    if (clicks >= 3) {
      clicks = 0;
      developerMode = !developerMode;
      document.body.classList.toggle('developer-mode', developerMode);
      if (currentAnalysis) renderRecommendation();
    }
  });
}

function setupLocationSearch() {
  const commitSelect = (which) => (c, forced) => {
    markRouteStale(true);
    if (forced) setTimeout(() => { if (!isAnalyzing) handleAnalyze(); }, 0);
  };
  originAuto = new LocationAutocomplete(document.getElementById('origin-input'), {
    onSelect: commitSelect('origin'),
    onInput: () => markRouteStale(true)
  });
  destAuto = new LocationAutocomplete(document.getElementById('dest-input'), {
    onSelect: commitSelect('dest'),
    onInput: () => markRouteStale(true)
  });

  // Clicking anywhere outside an input and its dropdown closes the open
  // suggestions. Clicks inside a dropdown are intentionally NOT processed
  // here (pointerdown fires before the row's mousedown selector) so the
  // selection handler always runs first.
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.loc-dropdown')) return;
    const o = document.getElementById('origin-input');
    const d = document.getElementById('dest-input');
    if (o && o.contains(e.target)) return;
    if (d && d.contains(e.target)) return;
    if (originAuto) originAuto.close();
    if (destAuto) destAuto.close();
  });
}

function renderApp() {
  document.getElementById('app').innerHTML = `
    <header class="header">
      <div class="header-logo">⛈</div>
      <div class="header-text">
        <h1>WeatherGPT</h1>
        <p>Route Intelligence</p>
      </div>
    </header>

    <main class="main">
      <section class="search-section">
        <div class="search-fields">
          <div class="fromto-stack">
            <div class="search-input-wrap" id="origin-wrap">
              <span class="icon">📍</span>
              <input type="text" class="search-input" id="origin-input" placeholder="From" autocomplete="off" />
              <button class="loc-crosshair" id="loc-crosshair" title="Use my current location" aria-label="Use my current location">⌖</button>
            </div>
            <div class="fromto-sep"></div>
            <div class="search-input-wrap">
              <span class="icon">🏁</span>
              <input type="text" class="search-input" id="dest-input" placeholder="To" autocomplete="off" />
            </div>
          </div>
          <button class="voice-btn" id="voice-btn" title="Voice search" aria-label="Voice search">🎤</button>
        </div>
        <div class="current-loc-panel hidden" id="current-loc-panel">
          <span class="loc-pin">📍</span>
          <div class="loc-body">
            <div class="loc-title">Your current location</div>
            <div class="loc-sub" id="current-loc-name">Locating…</div>
            <div class="loc-actions">
              <button type="button" class="loc-action" id="current-loc-retry">Try again</button>
              <button type="button" class="loc-action" id="current-loc-fallback">Search starting point instead</button>
            </div>
          </div>
        </div>
        <div class="travel-mode-row" id="travel-mode-row">
          <span class="travel-mode-label" id="travel-mode-label">How are you travelling?</span>
          <div class="travel-mode-chips">
            <button class="mode-chip" data-mode="car">🚗 Car</button>
            <button class="mode-chip" data-mode="bike">🏍️ Bike</button>
            <button class="mode-chip" data-mode="bus">🚌 Bus</button>
            <button class="mode-chip" data-mode="walk">🚶 Walk</button>
            <button class="mode-chip" data-mode="flight">✈️ Flight</button>
          </div>
        </div>
        <div class="search-actions">
          <button class="analyze-btn" id="analyze-btn">
            <span>Analyze Route</span>
          </button>
          <div class="quick-chips">
            <button class="chip" data-origin="Bengaluru" data-dest="Mysuru">Bengaluru → Mysuru</button>
            <button class="chip" data-origin="Tumakuru" data-dest="Bengaluru">Tumakuru → Bengaluru</button>
            <button class="chip" data-origin="Mangaluru" data-dest="Hassan">Mangaluru → Hassan</button>
          </div>
        </div>
      </section>

      <div class="severe-alert" id="severe-alert">
        <span class="alert-icon" id="alert-icon">⚠️</span>
        <div class="alert-content">
          <h4 id="alert-title">Severe Weather Alert</h4>
          <p id="alert-message"></p>
          <p id="alert-vibration-status" class="alert-vib-status"></p>
        </div>
      </div>

      <div class="map-container">
        <div id="route-map"></div>
        <div class="route-summary-pill hidden" id="route-summary-pill">
          <span class="rsp-route" id="rsp-route"></span>
          <span class="rsp-arrow">➔</span>
          <span class="rsp-dest" id="rsp-dest"></span>
          <span class="rsp-dot">·</span>
          <span class="rsp-meta" id="rsp-meta"></span>
          <span class="rsp-alt hidden" id="rsp-alt"></span>
        </div>
        <div class="map-loading" id="map-loading">
          <div class="spinner-lg"></div>
          <p id="loading-text">Calculating route...</p>
        </div>
        <div class="map-error hidden" id="map-error">
          <span class="map-error-icon">🗺️</span>
          <p>Map temporarily unavailable</p>
          <span class="map-error-sub">We couldn't load map tiles. The route will still be calculated.</span>
        </div>
        <div class="journey-bar hidden" id="journey-bar">
          <div class="journey-status" id="journey-status">Enable location to start live tracking</div>
          <div class="journey-actions">
            <button class="journey-btn" id="live-btn">Start live tracking</button>
            <button class="journey-btn secondary hidden" id="follow-btn">Follow vehicle</button>
          </div>
        </div>
      </div>

      <div id="empty-state" class="empty-state">
        <div class="icon">🗺️</div>
        <h3>Plan your journey</h3>
        <p>Enter a starting location and destination to see weather intelligence for your route.</p>
      </div>

      <div id="results-container" class="hidden">
        <div class="stale-note hidden" id="stale-note">Route results are for a previous location — analyze again to update.</div>
        <div class="recommendation-card hidden" id="flight-card"></div>
        <div class="recommendation-card" id="rec-card"></div>
        <div class="timeline-section hidden" id="flight-timeline-section"></div>
        <div class="timeline-section" id="timeline-section"></div>
      </div>
    </main>

    <div class="voice-overlay" id="voice-overlay" role="dialog" aria-modal="true" aria-label="Voice search">
      <div class="voice-modal">
        <div class="voice-mic">🎤</div>
        <div class="voice-status" id="voice-status">Listening...</div>
        <div class="voice-transcript" id="voice-transcript"></div>
        <div class="voice-hint" id="voice-hint">Tell me where you're going</div>
        <button class="voice-retry-btn hidden" id="voice-retry-btn">Try again</button>
        <div class="voice-panel hidden" id="voice-panel">
          <div class="voice-view hidden" id="voice-view-route">
            <div class="vp-title">I understood</div>
            <div class="vp-row">
              <span class="vp-place" id="vp-origin">—</span>
              <span class="vp-arrow">→</span>
              <span class="vp-place" id="vp-dest">—</span>
            </div>
          </div>
          <div class="voice-view hidden" id="voice-view-confirm">
            <div class="vp-title" id="vp-confirm-title">Did you mean?</div>
            <div class="vc-suggestion" id="vc-suggestion"></div>
            <div class="vp-buttons">
              <button class="voice-action primary" id="voice-confirm-place">Confirm</button>
              <button class="voice-action" id="voice-retry">Try again</button>
            </div>
          </div>
          <div class="voice-view hidden" id="voice-view-ambiguous">
            <div class="vp-title">Which way are you travelling?</div>
            <div class="vc-suggestion" id="vc-ambiguous"></div>
          </div>
        </div>
        <button class="voice-cancel" id="voice-cancel">Cancel</button>
      </div>
    </div>

    <div class="error-toast" id="error-toast"></div>

    <div class="vibration-feedback hidden" id="vibration-feedback">
      <span class="vib-icon">📳</span>
      <span class="vib-text" id="vib-text"></span>
    </div>

    <div class="dev-test-panel" id="dev-test-panel">
      <div class="dev-toggle" id="dev-toggle" title="Dev: Test alert system">🛠</div>
      <div class="dev-controls hidden" id="dev-controls">
        <div class="dev-title">Alert System Test</div>
        <button class="dev-btn" id="dev-test-severe">Test Severe Alert</button>
        <div class="dev-log" id="dev-log"></div>
        <div class="dev-section">
          <div class="dev-title">Voice Diagnostics</div>
          <div class="voice-debug" id="voice-debug">
            <div class="vd-row"><span class="vd-k">Voice status</span><span class="vd-v" id="vd-status">Idle</span></div>
            <div class="vd-row"><span class="vd-k">Provider</span><span class="vd-v" id="vd-provider">—</span></div>
            <div class="vd-row"><span class="vd-k">Language</span><span class="vd-v" id="vd-language">—</span></div>
            <div class="vd-row"><span class="vd-k">STT transcript</span><span class="vd-v" id="vd-transcript">—</span></div>
            <div class="vd-row"><span class="vd-k">Origin candidate</span><span class="vd-v" id="vd-origin">—</span></div>
            <div class="vd-row"><span class="vd-k">Destination candidate</span><span class="vd-v" id="vd-dest">—</span></div>
            <div class="vd-row"><span class="vd-k">Geocoder status</span><span class="vd-v" id="vd-geo">—</span></div>
            <div class="vd-row"><span class="vd-k">Match confidence</span><span class="vd-v" id="vd-conf">—</span></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('analyze-btn').addEventListener('click', handleAnalyze);
  document.getElementById('loc-crosshair').addEventListener('click', () => {
    setCurrentOriginMode(currentOriginMode === 'current' ? 'search' : 'current');
  });
  document.getElementById('voice-btn').addEventListener('click', startVoice);
  document.getElementById('voice-cancel').addEventListener('click', teardownVoice);
  document.getElementById('voice-retry-btn').addEventListener('click', restartVoice);
  document.getElementById('voice-confirm-place').addEventListener('click', confirmVoicePlace);
  document.getElementById('voice-retry').addEventListener('click', restartVoice);
  document.getElementById('vc-ambiguous').addEventListener('click', (e) => {
    const btn = e.target.closest('.vc-opt');
    if (!btn || !voiceAmbiguousPlaces) return;
    document.querySelectorAll('#vc-ambiguous .vc-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const a = parseInt(btn.dataset.a, 10);
    const b = parseInt(btn.dataset.b, 10);
    const places = voiceAmbiguousPlaces;
    voiceAmbiguousPlaces = null;
    const sid = voiceSessionId;
    resolveAndApply(places[a], places[b], sid);
  });
  document.getElementById('live-btn').addEventListener('click', handleLiveToggle);
  document.getElementById('follow-btn').addEventListener('click', () => {
    if (!liveTracker) return;
    const on = liveTracker.toggleFollow();
    document.getElementById('follow-btn').classList.toggle('active', on);
  });

  document.getElementById('current-loc-retry').addEventListener('click', useCurrentLocation);
  document.getElementById('current-loc-fallback').addEventListener('click', () => setCurrentOriginMode('search'));

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const o = document.getElementById('origin-input');
      const d = document.getElementById('dest-input');
      o._editSeq = (o._editSeq || 0) + 1;
      d._editSeq = (d._editSeq || 0) + 1;
      o.value = chip.dataset.origin;
      d.value = chip.dataset.dest;
      o._selection = null;
      d._selection = null;
      if (o._autocomplete) o._autocomplete.close();
      if (d._autocomplete) d._autocomplete.close();
      markRouteStale(true);
      handleAnalyze();
    });
  });

  document.querySelectorAll('.mode-chip').forEach(ch => {
    ch.addEventListener('click', () => selectTravelMode(ch.dataset.mode));
  });

  document.getElementById('origin-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !(originAuto && originAuto.open)) handleAnalyze();
  });
  document.getElementById('dest-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !(destAuto && destAuto.open)) handleAnalyze();
  });

  // Per-field edit sequences let voice resolution refuse to overwrite a field
  // the user has edited while the geocoder was still resolving. The actual
  // bumping happens inside LocationAutocomplete (on typing and on selection).
  document.getElementById('origin-input')._editSeq = 0;
  document.getElementById('dest-input')._editSeq = 0;

  document.getElementById('dev-toggle').addEventListener('click', () => {
    document.getElementById('dev-controls').classList.toggle('hidden');
  });

  document.getElementById('dev-test-severe').addEventListener('click', () => {
    const result = simulateSevereAlert();
    addDevLog(`Test alert fired. Vibration supported: ${result.vibrationSupported}, triggered: ${result.vibrationTriggered}`);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const ov = document.getElementById('voice-overlay');
      if (ov && ov.classList.contains('active')) teardownVoice();
    }
  });

  vibrationDebugEl = document.getElementById('dev-log');
}

function setupTrackingInteractions() {
  if (!map) return;
  const disableFollow = () => {
    if (liveTracker && liveTracker.follow) {
      liveTracker.setFollow(false);
      const fb = document.getElementById('follow-btn');
      if (fb) fb.classList.remove('active');
    }
  };
  map.on('dragstart', disableFollow);
  map.on('wheel', disableFollow);
}

function setupAlertSystem() {
  onAlert((result) => {
    const { vibrationSupported, vibrationTriggered, alertData, reason } = result;

    if (alertData.isTest) {
      if (vibrationTriggered) {
        showVibrationFeedback('Test vibration sent');
      } else if (!vibrationSupported) {
        showVibrationFeedback('Visual alert only (vibration unsupported)');
      } else {
        showVibrationFeedback('Alert triggered (vibration in cooldown)');
      }
      return;
    }

    if (alertData.level === 'severe') {
      showAlertBanner(alertData, vibrationSupported, vibrationTriggered, reason);
    } else if (alertData.level === 'high') {
      showAlertBanner(alertData, vibrationSupported, vibrationTriggered, reason);
    }

    if (vibrationTriggered) {
      showVibrationFeedback('Severe weather vibration alert sent');
    } else if (!vibrationSupported) {
      showVibrationFeedback('Visual alert shown (device doesn\'t support vibration)');
    }
  });
}

function showAlertBanner(alertData, vibrationSupported, vibrationTriggered, reason) {
  const alert = document.getElementById('severe-alert');
  const title = document.getElementById('alert-title');
  const message = document.getElementById('alert-message');
  const vibStatus = document.getElementById('alert-vibration-status');
  const icon = document.getElementById('alert-icon');

  icon.textContent = alertData.level === 'severe' ? '🚨' : '⚠️';
  title.textContent = alertData.level === 'severe' ? 'Severe Weather Alert' : 'Weather Advisory';

  const parts = [];
  if (alertData.condition) parts.push(alertData.condition);
  if (alertData.segment) parts.push(`Segment: ${alertData.segment}`);
  if (alertData.summary) parts.push(alertData.summary);
  message.textContent = parts.join(' — ');

  if (vibrationTriggered) {
    vibStatus.textContent = '📳 Vibration alert sent';
  } else if (!vibrationSupported) {
    vibStatus.textContent = 'Visual alert shown (vibration not supported on this device)';
  } else if (reason === 'cooldown') {
    vibStatus.textContent = '';
  } else {
    vibStatus.textContent = '';
  }

  alert.classList.add('show');
}

function hideSevereAlert() {
  document.getElementById('severe-alert')?.classList.remove('show');
  const vibStatus = document.getElementById('alert-vibration-status');
  if (vibStatus) vibStatus.textContent = '';
}

function showVibrationFeedback(text) {
  const el = document.getElementById('vibration-feedback');
  const textEl = document.getElementById('vib-text');
  if (!el || !textEl) return;
  textEl.textContent = text;
  el.classList.remove('hidden');
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 3000);
}

function addDevLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  alertLog.push({ timestamp, message });
  if (vibrationDebugEl) {
    const line = document.createElement('div');
    line.className = 'dev-log-entry';
    line.textContent = `[${timestamp}] ${message}`;
    vibrationDebugEl.appendChild(line);
    vibrationDebugEl.scrollTop = vibrationDebugEl.scrollHeight;
  }
}

function initMap() {
  try {
    map = new maplibregl.Map({
      container: 'route-map',
      style: OSM_STYLE,
      center: [77.59, 12.97],
      zoom: 7,
      attributionControl: true
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    const fitBtn = document.createElement('button');
    fitBtn.className = 'maplibregl-ctrl map-fit-route-btn';
    fitBtn.innerHTML = '<span style="font-size:16px">⌖</span>';
    fitBtn.title = 'Fit map to route';
    fitBtn.id = 'map-fit-route-btn';
    fitBtn.style.display = 'none';
    fitBtn.addEventListener('click', () => {
      if (currentFlight && map) {
        const b = new maplibregl.LngLatBounds();
        b.extend([currentFlight.depAirport.lng, currentFlight.depAirport.lat]);
        b.extend([currentFlight.arrAirport.lng, currentFlight.arrAirport.lat]);
        map.fitBounds(b, { padding: 60, maxZoom: 9, duration: 800 });
        return;
      }
      if (currentRoute && currentRoute.route && currentRoute.route.geometry) {
        fitMapToRoute(currentRoute.route.geometry);
      }
    });

    const ctrlContainer = document.querySelector('.maplibregl-ctrl-top-right') || map.getContainer();
    const wrapper = document.createElement('div');
    wrapper.className = 'maplibregl-ctrl-group';
    wrapper.appendChild(fitBtn);
    ctrlContainer.appendChild(wrapper);

    map.on('error', (e) => {
      console.warn('Map error:', e.error?.message || e);
      const errEl = document.getElementById('map-error');
      if (errEl) errEl.classList.remove('hidden');
    });

    map.on('load', () => {
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'route-line-bg',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#8B7CF6',
          'line-width': 8,
          'line-opacity': 0.3
        },
        filter: ['==', '$type', 'LineString']
      });

      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#8B7CF6',
          'line-width': 4,
          'line-opacity': 0.9
        },
        filter: ['==', '$type', 'LineString']
      });

      map.addSource('route-seg', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'route-line-segments',
        type: 'line',
        source: 'route-seg',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'severity'],
            'NORMAL', '#22C55E',
            'REDUCED', '#F59E0B',
            'ADVERSE', '#EF4444',
            'SEVERE', '#B91C1C',
            '#94A3B8'
          ],
          'line-width': 5,
          'line-opacity': 0
        },
        filter: ['==', '$type', 'LineString']
      });

      map.addSource('progress', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'route-completed-line',
        type: 'line',
        source: 'progress',
        layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': 'none' },
        paint: {
          'line-color': '#B9B3D6',
          'line-width': 4,
          'line-opacity': 0.85
        },
        filter: ['==', '$type', 'LineString']
      });

      map.addLayer({
        id: 'route-remaining-line',
        type: 'line',
        source: 'progress',
        layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': 'none' },
        paint: {
          'line-color': '#8B7CF6',
          'line-width': 5,
          'line-opacity': 0.95
        },
        filter: ['==', '$type', 'LineString']
      });
    });
  } catch (err) {
    console.error('Failed to initialize map:', err);
    const errEl = document.getElementById('map-error');
    if (errEl) errEl.classList.remove('hidden');
  }
}

function setRouteGeoJSON(geometry) {
  if (!map || !map.getSource('route')) return;
  if (!geometry || !geometry.coordinates) {
    map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  map.getSource('route').setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: geometry,
      properties: {}
    }]
  });
}

let mapMarkers = [];

const SEG_COLOR_BY_LEVEL = {
  NORMAL: '#22C55E',
  REDUCED: '#F59E0B',
  ADVERSE: '#EF4444',
  SEVERE: '#B91C1C',
  UNKNOWN: '#94A3B8'
};

function severityForFraction(checkpoints, f) {
  const n = checkpoints.length;
  if (n === 0) return 'UNKNOWN';
  for (let i = 0; i < n; i++) {
    const prevBound = i === 0 ? 0 : (checkpoints[i - 1].fraction + checkpoints[i].fraction) / 2;
    const nextBound = i === n - 1 ? 1 : (checkpoints[i].fraction + checkpoints[i + 1].fraction) / 2;
    if (f >= prevBound && f <= nextBound) {
      return (checkpoints[i].segment_severity && checkpoints[i].segment_severity.severity) || 'UNKNOWN';
    }
  }
  return 'UNKNOWN';
}

function buildSegmentFeatures(checkpoints, geometry) {
  if (!geometry || !geometry.coordinates || geometry.coordinates.length < 2 || !checkpoints || checkpoints.length === 0) {
    return [];
  }
  const coords = geometry.coordinates;
  const cache = getDistanceCache(geometry);
  const totalKm = cache[cache.length - 1] || 1;

  const groups = [];
  let current = null;
  for (let v = 0; v < coords.length; v++) {
    const f = totalKm > 0 ? cache[v] / totalKm : v / Math.max(coords.length - 1, 1);
    const sev = severityForFraction(checkpoints, f);
    if (!current || current.severity !== sev) {
      current = { severity: sev, coords: [coords[v]] };
      groups.push(current);
    } else {
      current.coords.push(coords[v]);
    }
  }

  return groups.map(g => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: g.coords },
    properties: { severity: g.severity }
  }));
}

function updateRouteSegments(checkpoints, geometry) {
  if (!map || !map.getSource('route-seg')) return;
  const features = buildSegmentFeatures(checkpoints, geometry);
  map.getSource('route-seg').setData({ type: 'FeatureCollection', features });
}

function drawRouteIn() {
  if (!map || !map.getLayer('route-line') || !map.getLayer('route-line-segments')) return;
  const DASH = 80000;
  map.setPaintProperty('route-line', 'line-dasharray', [0.0001, DASH]);
  map.setPaintProperty('route-line', 'line-opacity', 0.9);
  map.setPaintProperty('route-line-segments', 'line-opacity', 0);
  if (drawRouteIn.raf) window.cancelAnimationFrame(drawRouteIn.raf);
  const t0 = performance.now();
  const dur = 900;
  const step = (now) => {
    const p = Math.min((now - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    map.setPaintProperty('route-line', 'line-dasharray', [Math.max(eased * DASH, 0.0001), DASH]);
    if (p < 1) {
      drawRouteIn.raf = requestAnimationFrame(step);
    } else {
      map.setPaintProperty('route-line', 'line-dasharray', [1, 0]);
      map.setPaintProperty('route-line', 'line-opacity', 0.2);
      map.setPaintProperty('route-line-segments', 'line-opacity', 1);
    }
  };
  drawRouteIn.raf = requestAnimationFrame(step);
}

function clearRouteDraw() {
  if (drawRouteIn.raf) window.cancelAnimationFrame(drawRouteIn.raf);
  drawRouteIn.raf = null;
  if (!map || !map.getLayer) return;
  if (map.getLayer('route-line')) {
    map.setPaintProperty('route-line', 'line-dasharray', [1, 0]);
    map.setPaintProperty('route-line', 'line-opacity', 0.2);
  }
  if (map.getLayer('route-line-segments')) {
    map.setPaintProperty('route-line-segments', 'line-opacity', 0);
  }
}

function renderRouteForCurrent() {
  if (!currentRoute || !currentAnalysis || !map || !map.getLayer('route-line')) return;
  const geometry = currentRoute.route.geometry;
  if (!geometry || !geometry.coordinates) return;
  updateRouteSegments(currentAnalysis.checkpoints, geometry);
  drawRouteIn();
}

function clearMapMarkers() {
  for (const m of mapMarkers) m.remove();
  mapMarkers = [];
  clearWeatherPins();
}

function addMapMarker(lat, lng, html, anchor = 'center') {
  if (!map) return null;
  const el = document.createElement('div');
  el.innerHTML = html;
  el.style.cursor = 'pointer';
  const marker = new maplibregl.Marker({ element: el, anchor })
    .setLngLat([lng, lat])
    .addTo(map);
  mapMarkers.push(marker);
  return marker;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fitMapToRoute(geometry) {
  if (!map || !geometry || !geometry.coordinates || geometry.coordinates.length === 0) return;

  const coords = geometry.coordinates;
  const bounds = new maplibregl.LngLatBounds();
  for (const c of coords) bounds.extend(c);
  if (currentRoute?.origin?.lng != null) bounds.extend([currentRoute.origin.lng, currentRoute.origin.lat]);
  if (currentRoute?.destination?.lng != null) bounds.extend([currentRoute.destination.lng, currentRoute.destination.lat]);

  const routeKm = currentRoute ? currentRoute.distance / 1000 : null;
  let maxZoom = 12;
  if (routeKm !== null) {
    if (routeKm < 30) maxZoom = 13;
    else if (routeKm < 80) maxZoom = 12;
    else if (routeKm < 200) maxZoom = 11;
    else maxZoom = 10;
  }

  const isMobile = window.innerWidth < 600;
  const padding = isMobile ? 72 : 60;

  map.fitBounds(bounds, { padding, maxZoom, duration: 800 });
}

function pointSeverity(point) {
  return (point.segment_severity && point.segment_severity.severity) || point.severity || null;
}

function pickInflectionPoints(weatherData) {
  const pts = [];
  let lastSev = null;
  for (let i = 0; i < weatherData.length; i++) {
    const point = weatherData[i];
    if (i === 0 || i === weatherData.length - 1) continue;
    const sev = pointSeverity(point);
    if (sev !== lastSev) {
      pts.push(point);
      lastSev = sev;
    }
  }
  return pts.slice(0, 3);
}

function clearWeatherPins() {
  for (const m of weatherPinMarkers) m.remove();
  weatherPinMarkers = [];
}

function addWeatherMarkersToMap(weatherData) {
  clearWeatherPins();
  if (!weatherData) return;
  const points = pickInflectionPoints(weatherData);
  for (const point of points) {
    if (!point.weather || point.weather.error) continue;
    const w = point.weather;
    const sevColor = SEG_COLOR_BY_LEVEL[pointSeverity(point) || 'UNKNOWN'];
    const el = document.createElement('div');
    el.className = 'maplibre-popup-marker';
    el.style.borderColor = sevColor;
    el.innerHTML = `<div class="route-weather-marker" style="border-color:${sevColor}"><div>${w.conditionIcon || '🌤️'} ${w.temperature != null ? Math.round(w.temperature) + '°' : ''}</div></div>`;
    const popup = new maplibregl.Popup({ offset: 15, closeButton: false }).setHTML(
      `<div class="weather-popup"><span class="temp">${w.conditionIcon || ''} ${w.temperature != null ? Math.round(w.temperature) + '°C' : 'N/A'}</span><br><span class="condition">${w.condition || 'Unknown'}</span></div>`
    );
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([point.lng, point.lat])
      .setPopup(popup)
      .addTo(map);
    weatherPinMarkers.push(marker);
  }
}

function updateWeatherPinsIncidental(checkpoints) {
  if (!map || checkpoints.length === 0) return;
  clearWeatherPins();
  const pts = pickInflectionPoints(checkpoints);
  for (const point of pts) {
    if (!point.weather || point.weather.error) continue;
    const w = point.weather;
    const sevColor = SEG_COLOR_BY_LEVEL[pointSeverity(point) || 'UNKNOWN'];
    const el = document.createElement('div');
    el.className = 'maplibre-popup-marker';
    el.innerHTML = `<div class="route-weather-marker" style="border-color:${sevColor}"><div>${w.conditionIcon || '🌤️'} ${w.temperature != null ? Math.round(w.temperature) + '°' : ''}</div></div>`;
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([point.lng, point.lat])
      .addTo(map);
    weatherPinMarkers.push(marker);
  }
}

function createPlaceMarkerIcon(kind, name) {
  const el = document.createElement('div');
  el.className = `place-marker place-${kind}`;
  el.innerHTML = `
    <span class="place-dot ${kind}"></span>
    <span class="place-label">${kind === 'end' ? 'Destination' : (kind === 'current' ? 'My location' : 'Start')}</span>
    <span class="place-name">${escapeHtml(name)}</span>
  `;
  return el;
}

function drawMarkers(origin, destination) {
  const originKind = origin.source === 'current' ? 'current' : 'start';
  addMapMarker(origin.lat, origin.lng, createPlaceMarkerIcon(originKind, origin.shortName).outerHTML, 'center');
  addMapMarker(destination.lat, destination.lng, createPlaceMarkerIcon('end', destination.shortName).outerHTML, 'center');
}

function markRouteStale(on) {
  const container = document.getElementById('results-container');
  const note = document.getElementById('stale-note');
  if (!container) return;
  if (on) {
    container.classList.add('stale');
    if (note) note.classList.remove('hidden');
    if (map && map.getSource && map.getSource('route')) setRouteGeoJSON(null);
    clearRouteDraw();
    clearMapMarkers();
  } else {
    container.classList.remove('stale');
    if (note) note.classList.add('hidden');
  }
}

async function resolveInputLocation(which) {
  if (which === 'origin' && currentOriginMode === 'current') {
    if (currentLocation) {
      return withShortName({
        ...currentLocation,
        shortName: currentLocation.shortName || 'Your current location'
      });
    }
    return { error: 'Couldn\u2019t get your current location. Tap \u201CUse my current location\u201D and allow access.' };
  }

  const input = which === 'origin' ? document.getElementById('origin-input') : document.getElementById('dest-input');
  const auto = which === 'origin' ? originAuto : destAuto;
  const text = input.value.trim();
  if (!text) return { error: 'Please enter a location.' };

  const sel = input._selection;
  if (sel && sel.lat != null) {
    const t = text.toLowerCase();
    const short = (sel.placeName || (sel.displayName || '').split(',')[0] || '').toLowerCase();
    if (t === short || t === selectionDisplay(sel).toLowerCase()) return withShortName(sel);
  }

  if (auto && auto.open && auto.analysis && auto.analysis.confident) {
    const idx = auto.activeIndex >= 0 ? auto.activeIndex : 0;
    const item = auto.items[idx];
    if (item && item.c) return withShortName(item.c);
  }

  const res = await resolveLocationText(text);
  if (res.status === 'resolved') return withShortName(res.selection);
  if (res.status === 'error') {
    return {
      error: res.reason === 'busy'
        ? 'Location search is busy. Wait a moment and try again.'
        : 'Location search is temporarily unavailable. Please try again.'
    };
  }
  if (res.status === 'suggest') {
    return {
      suggest: true,
      didYouMean: res.didYouMean,
      ambiguous: res.ambiguous,
      suggestions: res.suggestions,
      query: text
    };
  }
  return { error: `No matching places found for "${text}". Try a nearby city or check the spelling.` };
}

function showLocationSuggestion(which, res) {
  const auto = which === 'origin' ? originAuto : destAuto;
  if (!auto) return;
  const heading = res.ambiguous ? 'which' : (res.didYouMean ? 'didyoumean' : null);
  auto.showSuggestion(res.suggestions || [], { didYouMean: res.didYouMean, heading });
  auto.input.focus();
  showError(res.didYouMean
    ? `Did you mean ${res.suggestions?.[0]?.placeName || 'this place'}? Select it to continue.`
    : 'Multiple places match. Select the one you mean to continue.');
}

function withShortName(c) {
  return { ...c, shortName: c.placeName || (c.displayName || '').split(',')[0] || '' };
}

/* ================= Use My Current Location ================= */

function setCurrentOriginMode(mode) {
  currentOriginMode = mode === 'current' ? 'current' : 'search';
  const isCurrent = currentOriginMode === 'current';
  const wrap = document.getElementById('origin-wrap');
  const panel = document.getElementById('current-loc-panel');
  const crosshair = document.getElementById('loc-crosshair');
  const originInput = document.getElementById('origin-input');
  if (originInput) originInput._editSeq = (originInput._editSeq || 0) + 1;

  if (wrap) wrap.style.display = isCurrent ? 'none' : '';
  if (crosshair) crosshair.classList.toggle('active', isCurrent);
  if (panel) panel.classList.toggle('hidden', !isCurrent);

  if (isCurrent) {
    if (originInput && originInput._autocomplete) originInput._autocomplete.close();
    useCurrentLocation();
  } else {
    currentLocationToken++;
    currentLocation = null;
    markRouteStale(true);
  }
}

function useCurrentLocation() {
  const panel = document.getElementById('current-loc-panel');
  const nameEl = document.getElementById('current-loc-name');
  const retryEl = document.getElementById('current-loc-retry');
  const fallbackEl = document.getElementById('current-loc-fallback');
  const token = ++currentLocationToken;

  const setSub = (text, state) => {
    if (nameEl) nameEl.textContent = text;
    if (retryEl) retryEl.classList.toggle('hidden', state !== 'failed');
    if (fallbackEl) fallbackEl.classList.toggle('hidden', state !== 'failed');
    if (panel) panel.classList.remove('loc-failed');
    if (state === 'failed' && panel) panel.classList.add('loc-failed');
  };

  const isStale = () => token !== currentLocationToken || currentOriginMode !== 'current';

  if (!('geolocation' in navigator)) {
    setSub('Location access is unavailable in this browser. Use search for a starting point instead.', 'failed');
    return;
  }

  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    setSub('Location access requires a secure connection (HTTPS or localhost). Use search for a starting point instead.', 'failed');
    return;
  }

  setSub('Detecting your location\u2026', 'loading');
  currentLocation = null;

  navigator.geolocation.getCurrentPosition((pos) => {
    if (isStale()) return;
    const { latitude, longitude, accuracy } = pos.coords;
    reverseGeocode(latitude, longitude).then((rev) => {
      if (isStale()) return;
      const name = (rev && rev.shortName) || 'this location';
      currentLocation = {
        lat: latitude,
        lng: longitude,
        accuracy: accuracy != null ? accuracy : null,
        timestamp: Date.now(),
        placeName: name,
        region: (rev && rev.region) || '',
        displayName: (rev && rev.displayName) || 'Your current location',
        shortName: name === 'this location' ? 'Your current location' : name,
        source: 'current'
      };
      const parts = [currentLocation.shortName, currentLocation.region].filter(Boolean);
      let label = parts.join(', ') || 'Your current location';
      if (currentLocation.accuracy != null && currentLocation.accuracy > 1000) label += ' (limited accuracy)';
      setSub(label, 'ready');
      markRouteStale(true);
    }).catch(() => {
      if (isStale()) return;
      currentLocation = {
        lat: latitude,
        lng: longitude,
        accuracy: accuracy != null ? accuracy : null,
        timestamp: Date.now(),
        placeName: 'Your current location',
        region: '',
        displayName: 'Your current location',
        shortName: 'Your current location',
        source: 'current'
      };
      setSub('Your current location detected', 'ready');
      markRouteStale(true);
    });
  }, (err) => {
    if (isStale()) return;
    let msg = 'Couldn\u2019t get your current location. Try again or search for a starting point.';
    if (err && err.code === 1) {
      msg = 'Location permission was denied. Search for a starting point instead.';
    } else if (err && err.code === 2) {
      msg = 'Your current location couldn\u2019t be determined. Try again or search for a starting point.';
    } else if (err && err.code === 3) {
      msg = 'Location detection timed out. Try again or search for a starting point.';
    }
    setSub(msg, 'failed');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

async function handleAnalyze(opts = {}) {
  if (isAnalyzing) return;

  const asAlt = !!opts.alt;
  if (!asAlt) altIndex = 0;
  const routeIndex = altIndex;

  const originText = document.getElementById('origin-input').value.trim();
  const destText = document.getElementById('dest-input').value.trim();

  if (currentOriginMode !== 'current' && !originText) { showError('Please enter a starting location.'); return; }
  if (currentOriginMode === 'current' && !currentLocation) {
    showError('Tap \u201CUse my current location\u201D and allow access before analyzing.');
    return;
  }
  if (!destText) { showError('Please enter a destination.'); return; }

  if (!travelMode) {
    showError('Select how you are travelling (Car, Bike, Bus, Walk or Flight) before analyzing.');
    highlightTravelMode(true);
    return;
  }
  highlightTravelMode(false);
  departureTime = new Date(Date.now() + departureShiftHours * 3600e3);
  markRouteStale(false);

  if (liveTracker) {
    liveMode = false;
    lastLiveRenderIdx = -1;
    liveTracker.stop();
  }
  document.getElementById('follow-btn')?.classList.add('hidden');
  document.getElementById('follow-btn')?.classList.remove('active');
  setRouteLineVisibility('plan');

  setAnalyzing(true);
  currentFlight = null;
  const myVersion = ++analysisVersion;
  showLoading('Locating places...');
  hideError();
  hideSevereAlert();
  clearMapMarkers();
  setRouteGeoJSON(null);

  try {
    showLoading('Locating starting place...');
    const originResult = await resolveInputLocation('origin');
    if (originResult.error) { showError(originResult.error); setAnalyzing(false); hideLoading(); return; }
    if (originResult.suggest) { showLocationSuggestion('origin', originResult); setAnalyzing(false); hideLoading(); return; }

    showLoading('Locating destination...');
    const destResult = await resolveInputLocation('dest');
    if (destResult.error) { showError(destResult.error); setAnalyzing(false); hideLoading(); return; }
    if (destResult.suggest) { showLocationSuggestion('dest', destResult); setAnalyzing(false); hideLoading(); return; }

    if (travelMode === 'flight') {
      await handleFlightAnalysis(originResult, destResult);
      return;
    }

    showLoading('Building journey analysis...');
    const analysis = await runJourneyAnalysis({
      origin: originResult,
      destination: destResult,
      travelMode,
      departureTime,
      onStatus: showLoading,
      routeIndex
    });
    if (!analysis || analysis.error) {
      showError(analysis?.error || 'Analysis failed. Please try again.');
      setAnalyzing(false);
      hideLoading();
      return;
    }
    if (myVersion !== analysisVersion) return;

    currentAnalysis = analysis;
    altCount = analysis.route?.available_routes || 1;
    const primary = analysis.route.primary_route;
    currentRoute = {
      origin: originResult,
      destination: destResult,
      route: primary,
      routes: [primary],
      distance: analysis.route.distance_m,
      duration: analysis.route.duration_s
    };
    applyAnalysisToState(analysis);

    if (map && map.loaded()) {
      setRouteGeoJSON(primary.geometry);
      renderRouteForCurrent();
    } else if (map) {
      map.on('load', () => { setRouteGeoJSON(primary.geometry); renderRouteForCurrent(); });
    }

    drawMarkers(originResult, destResult);

    const fitBtn = document.getElementById('map-fit-route-btn');
    if (fitBtn) fitBtn.style.display = 'flex';

    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('results-container').classList.remove('hidden');
    setFlightUIVisible(false);

    if (map) {
      requestAnimationFrame(() => {
        map.resize();
        requestAnimationFrame(() => fitMapToRoute(primary.geometry));
      });
    }

    renderRecommendation();
    renderTimeline();
    timelineSheetOpen = true;
    const tlSection = document.getElementById('timeline-section');
    if (tlSection) tlSection.classList.add('sheet-open');
    if (tlSection) tlSection.classList.remove('rendered');
    const chev0 = document.getElementById('chev-icon');
    if (chev0) chev0.textContent = '⌄';
    const chevBtn0 = document.getElementById('timeline-chevron');
    if (chevBtn0) chevBtn0.textContent = 'Hide Timeline ⌄';

    if (currentRisk.level === 'severe' || currentRisk.level === 'high') {
      const worstHazard = analysis.hazards[0];
      triggerSevereAlert({
        level: currentRisk.level,
        condition: worstHazard ? `${worstHazard.feature} — ${worstHazard.value} at ${worstHazard.place_name}` : currentRisk.summary,
        segment: `${originResult.shortName} → ${destResult.shortName}`,
        summary: currentRisk.summary
      });
    } else {
      hideSevereAlert();
    }

    addWeatherMarkersToMap(currentRouteWeather);
  } catch (err) {
    showError('An unexpected error occurred. Please try again.');
    console.error(err);
  } finally {
    setAnalyzing(false);
    hideLoading();
  }
}

/* ================= Flight Mode (separate workflow) ================= */

function setFlightUIVisible(on) {
  const flightCard = document.getElementById('flight-card');
  const flightTimeline = document.getElementById('flight-timeline-section');
  const recCard = document.getElementById('rec-card');
  const timeline = document.getElementById('timeline-section');
  const jBar = document.getElementById('journey-bar');
  const pill = document.getElementById('route-summary-pill');
  if (flightCard) flightCard.classList.toggle('hidden', !on);
  if (flightTimeline) flightTimeline.classList.toggle('hidden', !on);
  if (pill) pill.classList.toggle('hidden', on);
  if (on) {
    if (recCard) recCard.classList.add('hidden');
    if (timeline) timeline.classList.add('hidden');
    if (jBar) jBar.classList.add('hidden');
  } else {
    if (recCard) recCard.classList.remove('hidden');
    if (timeline) timeline.classList.remove('hidden');
    if (jBar) jBar.classList.remove('hidden');
  }
}

async function handleFlightAnalysis(originResult, destResult) {
  showLoading('Finding airports near the departure city...');

  const [originAirports, destAirports] = await Promise.all([
    findNearestAirports(originResult.lat, originResult.lng),
    findNearestAirports(destResult.lat, destResult.lng)
  ]);

  const depAirport = originAirports && originAirports[0];
  const arrAirport = destAirports && destAirports[0];

  if (!depAirport || !arrAirport) {
    const missing = !depAirport
      ? (originResult.shortName || 'the departure city')
      : (destResult.shortName || 'the arrival city');
    showError(`No airport found within 250 km of ${missing}. This route may not be practical by air.`);
    return;
  }

  showLoading('Approximating flight time...');
  const airKm = greatCircleKm(depAirport, arrAirport);
  const estMin = estimateFlightMinutes(airKm);

  const places = [
    { name: depAirport.name, lat: depAirport.lat, lng: depAirport.lng, fraction: 0, isStart: true, isEnd: false },
    { name: arrAirport.name, lat: arrAirport.lat, lng: arrAirport.lng, fraction: 1, isStart: false, isEnd: true }
  ];

  showLoading('Sampling rain, wind and visibility at both airports...');
  const weatherPlaces = await getWeatherForPlaces(places, {
    departureTime,
    totalDuration: estMin * 60
  });

  const decision = getFlightDecision({
    departure: weatherPlaces[0],
    arrival: weatherPlaces[1],
    estFlightMin: estMin
  });

  currentFlight = {
    originCity: originResult,
    destCity: destResult,
    depAirport: weatherPlaces[0],
    arrAirport: weatherPlaces[1],
    airKm,
    estMin,
    decision
  };

  clearMapMarkers();
  setRouteGeoJSON({
    type: 'LineString',
    coordinates: [[depAirport.lng, depAirport.lat], [arrAirport.lng, arrAirport.lat]]
  });
  addMapMarker(depAirport.lat, depAirport.lng, createPlaceMarkerIcon('start', `${depAirport.name} (departure)`).outerHTML, 'center');
  addMapMarker(arrAirport.lat, arrAirport.lng, createPlaceMarkerIcon('end', `${arrAirport.name} (arrival)`).outerHTML, 'center');

  const fitBtn = document.getElementById('map-fit-route-btn');
  if (fitBtn) fitBtn.style.display = 'flex';

  if (map && map.loaded()) {
    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([depAirport.lng, depAirport.lat]);
    bounds.extend([arrAirport.lng, arrAirport.lat]);
    map.fitBounds(bounds, { padding: 60, maxZoom: 9, duration: 800 });
  }

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('results-container').classList.remove('hidden');
  setFlightUIVisible(true);

  renderFlightCard();
  renderFlightTimeline();
}

function renderFlightCard() {
  const card = document.getElementById('flight-card');
  if (!card || !currentFlight) return;

  const f = currentFlight;
  const decision = f.decision;
  const riskClass = { go: 'low', caution: 'moderate', delay: 'high', avoid: 'severe' }[decision.level] || 'low';

  const fmtWeather = (w) => {
    if (!w || w.error) return 'Weather data unavailable';
    const bits = [];
    if (w.conditionIcon) bits.push(w.conditionIcon);
    if (w.condition && w.condition !== 'Unknown') bits.push(w.condition);
    if (w.temperature != null) bits.push(`${Math.round(w.temperature)}°C`);
    if (w.windSpeed != null) bits.push(`wind ${Math.round(w.windSpeed)} km/h`);
    if (w.hourly?.[0]?.precipitationProbability != null) bits.push(`rain ${w.hourly[0].precipitationProbability}%`);
    if (w.visibility != null) bits.push(w.visibility > 1000 ? `${(w.visibility / 1000).toFixed(1)} km visibility` : `${Math.round(w.visibility)} m visibility`);
    return bits.filter(Boolean).join(' · ') || 'Weather data unavailable';
  };

  card.classList.remove('hidden');
  card.innerHTML = `
    <div class="rec-header">
      <div class="rec-title">✈️ Flight Recommendation</div>
      <span class="risk-badge ${riskClass}">${decision.level}</span>
    </div>
    <div class="journey-decision decision-${decision.level}">
      <span class="jd-emoji">${decision.emoji}</span>
      <div class="jd-body">
        <div class="jd-title">${decision.title}</div>
        <div class="jd-msg">${escapeHtml(decision.message)}</div>
      </div>
    </div>
    <div class="rec-mode-row">
      <span class="mode-pill">✈️ Flight</span>
      <span class="jd-departure">Direct air distance ${f.airKm.toFixed(0)} km · estimated ${f.estMin} min flying time</span>
    </div>
    <div class="flight-airports">
      <div class="flight-airport">
        <span class="fa-label">Departure</span>
        <span class="fa-name">${escapeHtml(f.depAirport.name)}</span>
        <span class="fa-meta">near ${escapeHtml(f.originCity.shortName)}</span>
      </div>
      <div class="flight-routeline">✈️</div>
      <div class="flight-airport">
        <span class="fa-label">Arrival</span>
        <span class="fa-name">${escapeHtml(f.arrAirport.name)}</span>
        <span class="fa-meta">near ${escapeHtml(f.destCity.shortName)}</span>
      </div>
    </div>
    <button class="why-toggle" id="flight-why-toggle">Why this recommendation? ▾</button>
    <div class="why-details" id="flight-why-details">
      <div class="why-detail-row">
        <span class="label">Departure weather (${escapeHtml(f.depAirport.name)})</span>
        <span class="value">${escapeHtml(fmtWeather(f.depAirport.weather))}</span>
      </div>
      <div class="why-detail-row">
        <span class="label">Arrival weather (${escapeHtml(f.arrAirport.name)})</span>
        <span class="value">${escapeHtml(fmtWeather(f.arrAirport.weather))}</span>
      </div>
      <div class="why-detail-row">
        <span class="label">Direct air distance</span>
        <span class="value">${f.airKm.toFixed(0)} km</span>
      </div>
      <div class="why-detail-row">
        <span class="label">Estimated flying time</span>
        <span class="value">${f.estMin} min (rough estimate from distance)</span>
      </div>
      <div class="why-detail-row">
        <span class="label">Weather concerns</span>
        <span class="value">${escapeHtml(decision.detail)}</span>
      </div>
      <div class="flight-note">Weather is sampled at both airports for around departure and arrival time. Live air traffic, runway closures and airline schedules are not modelled — this is a weather-only pointer.</div>
    </div>
  `;

  document.getElementById('flight-why-toggle').addEventListener('click', () => {
    const details = document.getElementById('flight-why-details');
    const btn = document.getElementById('flight-why-toggle');
    const isShown = details.classList.toggle('show');
    btn.textContent = isShown ? 'Hide details ▴' : 'Why this recommendation? ▾';
  });
}

function renderFlightTimeline() {
  const section = document.getElementById('flight-timeline-section');
  if (!section || !currentFlight) return;
  const f = currentFlight;

  const fmtRows = (w) => {
    if (!w || w.error) return [];
    const rows = [];
    if (w.temperature != null) rows.push(`${Math.round(w.temperature)}°C`);
    if (w.windSpeed != null) rows.push(`💨 ${Math.round(w.windSpeed)} km/h`);
    if (w.hourly?.[0]?.precipitationProbability != null) rows.push(`🌧 ${w.hourly[0].precipitationProbability}%`);
    if (w.visibility != null) rows.push(w.visibility > 1000 ? `👁 ${(w.visibility / 1000).toFixed(1)} km` : `👁 ${Math.round(w.visibility)} m`);
    if (w.arrivalTime) {
      const at = new Date(w.arrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      rows.push(`🕐 ${at}`);
    }
    return rows;
  };

  const card = (place, role, nearName) => {
    const w = place.weather;
    const rows = fmtRows(w);
    const condition = (w && !w.error && w.condition) || 'No weather data';
    const icon = (w && !w.error && w.conditionIcon) || '🌤️';
    return `
      <div class="timeline-node plan ${role === 'arrival' ? 'is-end' : 'is-start'}">
        <div class="timeline-dot ${role === 'arrival' ? 'end' : 'start'}"></div>
        <div class="timeline-info">
          <div class="timeline-location">${escapeHtml(place.name)}</div>
          <div class="timeline-distance">${role === 'departure' ? 'Departure airport' : 'Arrival airport'} · near ${escapeHtml(nearName)}</div>
          <div class="timeline-weather">
            <span class="weather-icon">${icon}</span>
            <span class="condition">${condition}</span>
            ${rows.length ? `<div class="flight-rows">${rows.map(r => `<span class="flight-row-chip">${r}</span>`).join('')}</div>` : ''}
          </div>
        </div>
      </div>`;
  };

  section.classList.remove('hidden');
  section.innerHTML = `
    <div class="timeline-header">
      <h3>✈️ Airport Weather</h3>
      <p>Conditions at departure and arrival airports (forecast matched to travel time)</p>
    </div>
    <div class="timeline" id="flight-timeline">
      ${card(f.depAirport, 'departure', f.originCity.shortName)}
      ${card(f.arrAirport, 'arrival', f.destCity.shortName)}
    </div>
  `;
}

function handleSwap() {
  if (currentOriginMode === 'current') {
    showError('Your starting point is your current location — search the destination to swap instead.');
    return;
  }
  const origin = document.getElementById('origin-input');
  const dest = document.getElementById('dest-input');
  origin._editSeq = (origin._editSeq || 0) + 1;
  dest._editSeq = (dest._editSeq || 0) + 1;
  const tmp = origin.value;
  origin.value = dest.value;
  dest.value = tmp;
  const sel = origin._selection;
  origin._selection = dest._selection || null;
  dest._selection = sel || null;
  if (origin._selection) origin.value = selectionDisplay(origin._selection);
  if (dest._selection) dest.value = selectionDisplay(dest._selection);
  origin._selectionVersion = (origin._selectionVersion || 0) + 1;
  dest._selectionVersion = (dest._selectionVersion || 0) + 1;
  markRouteStale(true);
}

function selectTravelMode(mode) {
  if (!MODES[mode]) return;
  travelMode = mode;
  document.querySelectorAll('.mode-chip').forEach(ch => {
    ch.classList.toggle('selected', ch.dataset.mode === mode);
  });
  highlightTravelMode(false);
  if (currentAnalysis) {
    currentAnalysis = reevalRecommendation(currentAnalysis, travelMode);
    currentRoute = {
      ...currentRoute,
      duration: currentAnalysis.route.duration_s
    };
    applyAnalysisToState(currentAnalysis);
    renderRecommendation();
    renderTimeline();
  }
}

function highlightTravelMode(on) {
  const label = document.getElementById('travel-mode-label');
  if (!label) return;
  label.classList.toggle('attention', !!on);
  const chips = document.querySelectorAll('.mode-chip');
  chips.forEach(ch => ch.classList.toggle('attention', !!on && ch.dataset.mode !== travelMode));
}

const LEGACY_SEVERITY = { NORMAL: 'low', REDUCED: 'moderate', ADVERSE: 'high', SEVERE: 'severe', UNKNOWN: 'unknown' };
const LEGACY_LABEL = { GOOD_TO_GO: 'low', CAUTION: 'moderate', HIGH_IMPACT: 'high', SEVERE: 'severe', INSUFFICIENT_DATA: 'unknown' };
const DECISION_CLASS = { GOOD_TO_GO: 'go', CAUTION: 'caution', HIGH_IMPACT: 'delay', SEVERE: 'avoid', INSUFFICIENT_DATA: 'caution' };

function applyAnalysisToState(analysis) {
  const totalKm = analysis.route.distance_km;
  currentRouteWeather = analysis.checkpoints.map(cp => ({
    name: cp.place_name,
    lat: cp.lat,
    lng: cp.lng,
    fraction: cp.fraction,
    isStart: cp.is_start,
    isEnd: cp.is_end,
    weather: cp.weather,
    segmentSeverity: cp.segment_severity
  }));

  const severity = analysis.exposure.max_severity;
  currentRisk = {
    level: LEGACY_LABEL[analysis.recommendation.label] || 'low',
    score: null,
    maxSegmentSeverity: severity,
    segments: analysis.checkpoints.map(cp => ({
      fraction: cp.fraction,
      lat: cp.lat,
      lng: cp.lng,
      level: LEGACY_SEVERITY[cp.segment_severity.severity],
      description: `${cp.place_name} — ${cp.segment_severity.reason}`,
      weather: cp.weather
    })),
    details: analysis.checkpoints.map((cp, i) => {
      const sev = cp.segment_severity.severity;
      const w = cp.weather || {};
      return {
        fraction: cp.fraction,
        lat: cp.lat,
        lng: cp.lng,
        level: LEGACY_SEVERITY[sev],
        condition: w.condition || (w.error ? 'Weather data unavailable' : 'Unknown'),
        conditionIcon: w.conditionIcon || '',
        temperature: w.temperature,
        precipitation: w.precipitation,
        precipitationProbability: w.hourly?.[0]?.precipitationProbability,
        windSpeed: w.windSpeed,
        visibility: w.visibility,
        severity: sev,
        evidence: analysis.hazards.filter(h => h.checkpoint_index === i).map(h => `${h.feature} = ${h.value} (${h.severity})`)
      };
    }),
    summary: analysis.recommendation.headline,
    recommendation: analysis.recommendation.key_insight
  };

  const transitions = getWeatherTransitions(currentRouteWeather, analysis.resolution.travel_mode, {
    totalKm
  });

  travelContext = {
    mode: analysis.resolution.travel_mode,
    modeMeta: MODES[analysis.resolution.travel_mode],
    decision: {
      level: DECISION_CLASS[analysis.recommendation.label] || 'caution',
      emoji: analysis.recommendation.emoji,
      title: analysis.recommendation.headline,
      message: analysis.recommendation.key_insight
    },
    exposure: {
      affectedKm: Math.round(analysis.exposure.adverse_km),
      affectedPct: analysis.exposure.exposed_to_adverse_percent,
      reducedKm: Math.round(analysis.exposure.reduced_km),
      severeKm: Math.round(analysis.exposure.severe_km),
      unavailableKm: Math.round(analysis.exposure.unavailable_km),
      unavailablePct: analysis.exposure.unavailable_percent,
      maxSeverity: analysis.exposure.max_severity
    },
    transitions,
    summaryImpacts: analysis.hazards.slice(0, 2).map(h => ({
      level: LEGACY_SEVERITY[h.severity],
      text: `${h.description} (${h.place_name})`
    })),
    departureTime: new Date(analysis.resolution.departure_time)
  };
}

function recomputeTravelContext() {
  if (currentAnalysis) applyAnalysisToState(currentAnalysis);
}

function renderRecommendation() {
  if (!currentRoute || !currentRisk) return;

  const distKm = (currentRoute.distance / 1000).toFixed(1);
  const durH = Math.floor(currentRoute.duration / 3600);
  const durM = Math.round((currentRoute.duration % 3600) / 60);
  const durStr = durH > 0 ? `${durH}h ${durM}m` : `${durM}m`;

  const pill = document.getElementById('route-summary-pill');
  if (pill) {
    const originName = currentRoute.origin.shortName || currentRoute.origin.name || 'Start';
    const destName = currentRoute.destination.shortName || currentRoute.destination.name || 'Destination';
    document.getElementById('rsp-route').textContent = originName.toUpperCase();
    document.getElementById('rsp-dest').textContent = destName.toUpperCase();
    document.getElementById('rsp-meta').textContent = `${distKm} km · ${durStr}`;
    pill.classList.remove('hidden');
    const altTag = document.getElementById('rsp-alt');
    if (altCount > 1) {
      altTag.textContent = `Route ${altIndex + 1} of ${altCount}`;
      altTag.classList.remove('hidden');
    } else {
      altTag.classList.add('hidden');
    }
  }

  const avgWeather = getAverageWeather();
  const riskLevel = currentRisk.level;

  const decision = travelContext?.decision;
  const exposure = travelContext?.exposure;
  const modeMeta = travelContext?.modeMeta;
  const summaryImpacts = travelContext?.summaryImpacts || [];
  const departStr = travelContext?.departureTime
    ? travelContext.departureTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const decisionHtml = decision ? `
    <div class="journey-decision decision-${decision.level}">
      <span class="jd-emoji">${decision.emoji}</span>
      <div class="jd-body">
        <div class="jd-title">${decision.title}</div>
        <div class="jd-msg">${escapeHtml(decision.message)}</div>
      </div>
    </div>
  ` : '';

  const modeRowHtml = `
    <div class="rec-mode-row">
      <span class="mode-pill">${modeMeta ? modeMeta.icon + ' ' + modeMeta.label : '—'}</span>
      ${exposure ? `<span class="jd-exposure" id="verdict-exposure">Exposed to adverse weather: <b>${exposure.affectedKm} km</b> (${exposure.affectedPct}%)</span>` : ''}
      ${departStr ? `<span class="jd-departure" id="verdict-departure">Forecast from ${departStr}</span>` : ''}
    </div>
  `;

  const impactsHtml = summaryImpacts.length > 0 ? `
    <div class="mode-impacts">
      <div class="mi-title">${modeMeta ? modeMeta.icon + ' ' + modeMeta.label + ' perspective' : 'Mode'} — what to expect</div>
      ${summaryImpacts.slice(0, 2).map(i => `
        <div class="mi-item level-${i.level}">
          <span class="mi-dot">${IMPACT_EMOJI[i.level] || '🟢'}</span>
          <span>${escapeHtml(i.text)}</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  const avgSummary = (avgWeather.temp != null || (avgWeather.precipProb != null) || (avgWeather.wind != null))
    ? `${avgWeather.icon} ${avgWeather.condition || 'Unknown'}` +
      (avgWeather.temp != null ? ` · ${Math.round(avgWeather.temp)}°C` : '') +
      (avgWeather.precipProb != null ? ` · Rain ${avgWeather.precipProb}%` : '') +
      (avgWeather.wind != null ? ` · Wind ${Math.round(avgWeather.wind)} km/h` : '')
    : 'Weather data unavailable along this route.';

  const headline = decision ? decision.title : (currentRisk.summary || '');
  const headlineMsg = decision ? decision.message : '';
  const depLabel = departureShiftHours === 0
    ? 'Now'
    : (departureShiftHours < 24 ? `+${departureShiftHours}h` : `${Math.floor(departureShiftHours / 24)}d ${departureShiftHours % 24}h`);

  const card = document.getElementById('rec-card');
  card.innerHTML = `
    <div class="rec-header">
      <div class="rec-title">☀️ Safety Summary</div>
      <span class="risk-badge ${riskLevel}" id="verdict-badge">${riskLevel} risk</span>
    </div>
    <div class="verdict-headline" id="verdict-headline">${escapeHtml(headline)}</div>
    ${headlineMsg ? `<div class="verdict-msg" id="verdict-msg">${escapeHtml(headlineMsg)}</div>` : ''}
    <div class="departure-row compact">
      <div class="departure-head">
        <span class="departure-label">🕐 Departure time</span>
        <span class="departure-value" id="departure-value">${depLabel}</span>
      </div>
      <input type="range" class="departure-slider" id="departure-slider" min="0" max="24" step="1" value="${departureShiftHours}" aria-label="Shift departure time" />
      <div class="departure-ticks"><span>Now</span><span>+12h</span><span>+1 day</span></div>
    </div>
    <div class="rec-stats">
      <div class="rec-stat">
        <span class="label">Distance</span>
        <span class="value">${distKm} km</span>
      </div>
      <div class="rec-stat">
        <span class="label">Duration</span>
        <span class="value">${durStr}</span>
      </div>
      ${exposure ? `
      <div class="rec-stat">
        <span class="label">Adverse weather</span>
        <span class="value small">${exposure.affectedKm} km · ${exposure.affectedPct}%</span>
      </div>
      ` : ''}
    </div>
    <div class="rec-legend">
      <span class="legend-item"><i style="background:#22C55E"></i>Clear</span>
      <span class="legend-item"><i style="background:#F59E0B"></i>Watch</span>
      <span class="legend-item"><i style="background:#EF4444"></i>Adverse</span>
      <span class="legend-item"><i style="background:#B91C1C"></i>Severe</span>
    </div>
    ${modeRowHtml}
    ${impactsHtml}
    <button class="why-toggle" id="why-toggle">Why this recommendation? ▾</button>
    <div class="why-details" id="why-details">
      <div class="why-detail-row">
        <span class="label">Weather on the route</span>
        <span class="value">${escapeHtml(avgSummary)}</span>
      </div>
      <div class="why-detail-row">
        <span class="label">Overall risk assessment</span>
        <span class="value">${currentRisk.summary}</span>
      </div>
      <div class="why-detail-row">
        <span class="label">Recommendation</span>
        <span class="value">${currentRisk.recommendation}</span>
      </div>
      ${currentAnalysis?.explanation?.decision_rationale ? `
      <div class="why-detail-row">
        <span class="label">Decision rationale</span>
        <span class="value">${escapeHtml(currentAnalysis.explanation.decision_rationale)}</span>
      </div>
      ` : ''}
      ${currentAnalysis?.hazards?.length ? `
      <div class="why-detail-row">
        <span class="label">Weather hazards</span>
        <span class="value">${currentAnalysis.hazards.slice(0, 4).map(h => escapeHtml(`${h.severity} · ${h.feature} ${h.value} @ ${h.place_name}`)).join('<br/>')}</span>
      </div>
      ` : ''}
      ${currentRisk.maxSegmentSeverity ? `
      <div class="why-detail-row">
        <span class="label">Worst segment severity</span>
        <span class="value">${currentRisk.maxSegmentSeverity}</span>
      </div>
      ` : ''}
      ${currentRisk.details.map(d => `
        <div class="why-detail-row">
          <span class="label">${d.condition}${d.evidence.length > 0 ? ' (' + d.evidence.join('; ') + ')' : ''}</span>
          <span class="value">${d.temperature != null ? Math.round(d.temperature) + '°C' : 'N/A'}</span>
        </div>
      `).join('')}
      ${currentRisk.segments.filter(s => s.level !== 'low' && s.level !== 'unknown').length > 0 ? `
        <div class="risk-segments">
          <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-secondary);">Route segments with notable weather</div>
          ${currentRisk.segments.filter(s => s.level !== 'low' && s.level !== 'unknown').map(s => `
            <div class="risk-segment ${s.level}">
              <span>${s.description}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
    ${altCount > 1 ? `
    <button class="alt-routes-btn" id="alt-routes-btn">View Alternative Routes <span class="alt-count">${altIndex + 1}/${altCount}</span></button>
    ` : ''}
    ${currentAnalysis && developerMode ? `
    <details class="debug-details" open>
      <summary>Debug \u00b7 JourneyAnalysis v${currentAnalysis.schema_version}</summary>
      <div class="debug-body">
        <div class="debug-meta">query_id ${escapeHtml(currentAnalysis.query_id)} \u00b7 generated ${escapeHtml(currentAnalysis.generated_at)}</div>
        <pre>${escapeHtml(JSON.stringify(currentAnalysis.debug, null, 2))}</pre>
      </div>
    </details>
    ` : ''}
    <button class="timeline-chevron" id="timeline-chevron">View Timeline <span class="chev-icon" id="chev-icon">⌃</span></button>
  `;

  document.getElementById('why-toggle').addEventListener('click', () => {
    const details = document.getElementById('why-details');
    const btn = document.getElementById('why-toggle');
    const isShown = details.classList.toggle('show');
    btn.textContent = isShown ? 'Hide details ▴' : 'Why this recommendation? ▾';
  });

  const altBtn = document.getElementById('alt-routes-btn');
  if (altBtn) {
    altBtn.addEventListener('click', () => {
      if (isAnalyzing) return;
      altIndex = (altIndex + 1) % altCount;
      handleAnalyze({ alt: true });
    });
  }

  const depSlider = document.getElementById('departure-slider');
  const depValue = document.getElementById('departure-value');
  const depLabelFor = (h) => h === 0 ? 'Now' : (h < 24 ? `+${h}h` : `${Math.floor(h / 24)}d ${h % 24}h`);
  if (depSlider) {
    depSlider.addEventListener('input', () => {
      const h = parseInt(depSlider.value, 10);
      departureShiftHours = h;
      if (depValue) depValue.textContent = depLabelFor(h);
      if (currentRoute) applyDeparturePreview(h);
    });
    depSlider.addEventListener('change', () => {
      const h = parseInt(depSlider.value, 10);
      departureShiftHours = h;
      if (depValue) depValue.textContent = depLabelFor(h);
      if (currentRoute) applyDeparturePreview(h);
    });
  }

  const chevron = document.getElementById('timeline-chevron');
  if (chevron) {
    chevron.addEventListener('click', () => toggleTimelineSheet());
  }
}

function riskClassFromLabel(label) {
  switch (label) {
    case 'SEVERE': return 'severe';
    case 'HIGH_IMPACT': return 'high';
    case 'CAUTION': return 'moderate';
    case 'INSUFFICIENT_DATA': return 'unknown';
    default: return 'low';
  }
}

function applyDeparturePreview(hours) {
  if (!currentAnalysis || !currentRoute || !currentAnalysis.checkpoints) return;
  const cps = currentAnalysis.checkpoints;
  if (cps.length === 0 || !cps[0].hourlyForecast) return;
  try {
    const depDt = new Date(Date.now() + hours * 3600e3);
    const totalKm = currentRoute.distance / 1000;
    const res = recomputeForDeparture(cps, totalKm, currentRoute.duration, travelMode, depDt);
    updateRouteSegments(res.checkpoints, currentRoute.route.geometry);
    updateVerdictFrom(res, hours);
    updateWeatherPinsIncidental(res.checkpoints);
  } catch (err) {
    console.error('Departure preview failed:', err);
  }
}

function updateVerdictFrom(res, hours) {
  const r = res.recommendation;
  const headline = document.getElementById('verdict-headline');
  const msg = document.getElementById('verdict-msg');
  const badge = document.getElementById('verdict-badge');
  const exposureEl = document.getElementById('verdict-exposure');
  const departureEl = document.getElementById('verdict-departure');
  const depVal = document.getElementById('departure-value');

  if (headline) headline.textContent = r.headline;
  if (msg) msg.textContent = r.key_insight || '';
  if (badge) {
    badge.className = 'risk-badge ' + riskClassFromLabel(r.label);
    badge.textContent = r.label.replace('_', ' ').toLowerCase();
  }
  if (exposureEl && res.exposure) {
    exposureEl.innerHTML = `Exposed to adverse weather: <b>${Math.round(res.exposure.adverse_km)} km</b> (${res.exposure.exposed_to_adverse_percent}%)`;
  }
  if (departureEl) {
    departureEl.textContent = `Forecast from ${new Date(Date.now() + hours * 3600e3).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (depVal) {
    depVal.textContent = hours === 0 ? 'Now' : (hours < 24 ? `+${hours}h` : `${Math.floor(hours / 24)}d ${hours % 24}h`);
  }
  if (r.label === 'SEVERE' || r.label === 'HIGH_IMPACT') pulseRedSegment();
}

function pulseRedSegment() {
  if (!map || !map.getLayer('route-line-segments')) return;
  const layer = 'route-line-segments';
  map.setPaintProperty(layer, 'line-width', 8);
  setTimeout(() => map.setPaintProperty(layer, 'line-width', 5), 220);
  setTimeout(() => map.setPaintProperty(layer, 'line-width', 8), 440);
  setTimeout(() => map.setPaintProperty(layer, 'line-width', 5), 660);
}

function toggleTimelineSheet() {
  const section = document.getElementById('timeline-section');
  if (!section) return;
  timelineSheetOpen = !timelineSheetOpen;
  section.classList.toggle('sheet-open', timelineSheetOpen);
  const chev = document.getElementById('chev-icon');
  if (chev) chev.textContent = timelineSheetOpen ? '⌄' : '⌃';
  const btn = document.getElementById('timeline-chevron');
  if (btn) btn.textContent = timelineSheetOpen ? 'Hide Timeline ⌄' : 'View Timeline ⌃';
  if (timelineSheetOpen && !section.classList.contains('rendered')) {
    renderTimeline();
    section.classList.add('rendered');
  }
}

function getAverageWeather() {
  if (!currentRouteWeather || currentRouteWeather.length === 0) {
    return { icon: '🌤️', condition: 'Unknown', temp: null, precipProb: null, wind: null };
  }
  let tempSum = 0, windSum = 0, precipProbSum = 0;
  let tempCount = 0, windCount = 0, precipCount = 0;
  let mainCondition = '';
  let mainIcon = '🌤️';
  let maxSeverity = -1;

  for (const point of currentRouteWeather) {
    const w = point.weather;
    if (!w || w.error) continue;

    if (w.temperature != null) { tempSum += w.temperature; tempCount++; }
    if (w.windSpeed != null) { windSum += w.windSpeed; windCount++; }
    if (w.hourly?.[0]?.precipitationProbability != null) {
      precipProbSum += w.hourly[0].precipitationProbability;
      precipCount++;
    }

    const severity = w.weatherCode ?? -1;
    if (severity > maxSeverity) {
      maxSeverity = severity;
      mainCondition = w.condition || 'Unknown';
      mainIcon = w.conditionIcon || '🌤️';
    }
  }

  return {
    icon: mainIcon,
    condition: mainCondition,
    temp: tempCount > 0 ? tempSum / tempCount : null,
    wind: windCount > 0 ? windSum / windCount : null,
    precipProb: precipCount > 0 ? Math.round(precipProbSum / precipCount) : null
  };
}

/* ================= Weather Ahead / Journey Timeline ================= */

function formatMin(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function buildCheckpoints(currentFraction) {
  if (!currentRouteWeather || !currentRoute) return [];
  const live = currentFraction != null;
  const totalKm = currentRoute.distance / 1000;
  const totalSec = currentRoute.duration;

  let currentIdx = 0;
  if (live) {
    for (let i = 0; i < currentRouteWeather.length; i++) {
      if (currentRouteWeather[i].fraction <= currentFraction) currentIdx = i;
    }
    if (currentIdx >= currentRouteWeather.length - 1) {
      currentIdx = Math.max(0, currentRouteWeather.length - 2);
    }
  }

  return currentRouteWeather.map((point, i) => {
    const w = point.weather;
    const isStart = !!point.isStart;
    const isEnd = !!point.isEnd;

    let state = 'upcoming';
    if (live) {
      if (i < currentIdx) state = 'completed';
      else if (i === currentIdx) state = 'current';
    }

    const distAheadKm = Math.max(0, point.fraction - (live ? currentFraction : 0)) * totalKm;
    const minAhead = Math.max(0, point.fraction - (live ? currentFraction : 0)) * totalSec / 60;

    let distanceText;
    let etaText;
    if (isStart) {
      distanceText = live ? 'Completed' : 'Start';
      etaText = '';
    } else if (isEnd) {
      distanceText = live ? (distAheadKm <= 0.5 ? 'Destination' : `${distAheadKm.toFixed(1)} km ahead`) : 'Destination';
      etaText = live ? (minAhead <= 0 ? 'Arriving now' : `ETA ${formatMin(minAhead)}`) : formatETA(totalSec);
    } else {
      distanceText = live
        ? (state === 'current' ? 'You are here' : `${distAheadKm.toFixed(1)} km ahead`)
        : `${(point.fraction * totalKm).toFixed(1)} km ahead`;
      etaText = live ? (minAhead <= 0 ? 'Now' : `ETA ${formatMin(minAhead)}`) : formatETA(point.fraction * totalSec);
    }

    let riskLevel = 'low';
    let riskTag = '';
    if (w && !w.error) {
      const sev = currentRisk?.details?.[i]?.level || 'low';
      riskLevel = sev;
      if ((sev === 'high' || sev === 'severe') && !isStart) {
        riskTag = `<span class="timeline-risk-tag ${sev}">⚠ ${sev}</span>`;
      }
    }

    const transition = travelContext?.transitions?.find(t => t.atIndex === i);
    let repeatedWeather = false;
    if (i > 0 && w && !w.error) {
      const prevW = currentRouteWeather[i - 1]?.weather;
      if (prevW && !prevW.error && w.weatherCode != null && w.weatherCode === prevW.weatherCode) {
        repeatedWeather = true;
      }
    }

    return {
      index: i,
      name: point.name || (isStart ? 'Start' : isEnd ? 'Destination' : `${Math.max(1, Math.round((point.fraction || 0) * totalKm))} km mark`),
      isStart,
      isEnd,
      state,
      distanceText,
      etaText,
      weather: w,
      riskLevel,
      riskTag,
      lat: point.lat,
      lng: point.lng,
      fraction: point.fraction,
      transitionText: transition?.text || '',
      transitionWorsens: !!transition?.worsening,
      repeatedWeather
    };
  });
}

function chipRiskColor(level) {
  switch (level) {
    case 'low': return '#22C55E';
    case 'moderate': return '#F59E0B';
    case 'high': return '#EF4444';
    case 'severe': return '#B91C1C';
    default: return '#94A3B8';
  }
}

function renderTimelineChip(cp) {
  const w = cp.weather;
  const ok = w && !w.error;
  const color = chipRiskColor(cp.riskLevel);
  return `
    <div class="tl-chip" data-index="${cp.index}" style="--chip-color:${color}">
      <div class="chip-loc">${escapeHtml(cp.name || 'Route segment')}</div>
      <div class="chip-time">${cp.etaText || '—'}</div>
      <div class="chip-icon">${ok ? (w.conditionIcon || '🌤️') : '❔'}</div>
      <div class="chip-temp">${ok && w.temperature != null ? Math.round(w.temperature) + '°' : '—'}</div>
      <div class="chip-meta">
        ${ok && w.hourly?.[0]?.precipitationProbability != null ? `<span>💧 ${w.hourly[0].precipitationProbability}%</span>` : ''}
        ${ok && w.windSpeed != null ? `<span>💨 ${Math.round(w.windSpeed)} km/h</span>` : ''}
      </div>
    </div>
  `;
}

function renderTimeline(currentFraction) {
  const section = document.getElementById('timeline-section');
  if (!section) return;

  const live = currentFraction != null;
  const checkpoints = buildCheckpoints(currentFraction);

  if (!live) {
    section.classList.add('sheet-mode');
    section.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="timeline-header sheet-header">
        <div>
          <h3>🌤 Weather Ahead</h3>
          <p>Forecast matched to your arrival at each point · tap a chip to inspect</p>
        </div>
        <button class="sheet-close" id="sheet-close" aria-label="Close timeline">✕</button>
      </div>
      <div class="tl-chips" id="tl-chips">
        ${checkpoints.map(cp => renderTimelineChip(cp)).join('')}
      </div>
      <div class="timeline-detail" id="timeline-detail"></div>
    `;

    document.querySelectorAll('.tl-chip').forEach(node => {
      node.addEventListener('click', () => {
        document.querySelectorAll('.tl-chip').forEach(n => n.classList.remove('active'));
        node.classList.add('active');
        const idx = parseInt(node.dataset.index, 10);
        showTimelineDetail(checkpoints[idx]);
        const c = checkpoints[idx];
        if (map && c) {
          map.flyTo({ center: [c.lng, c.lat], zoom: Math.max(map.getZoom(), 10), duration: 600 });
        }
      });
    });

    const closeBtn = document.getElementById('sheet-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        timelineSheetOpen = false;
        section.classList.remove('sheet-open');
        const btn = document.getElementById('timeline-chevron');
        const chev = document.getElementById('chev-icon');
        if (btn) btn.textContent = 'View Timeline ⌃';
        if (chev) chev.textContent = '⌃';
      });
    }
    return;
  }

  section.classList.remove('sheet-mode');

  const fillPct = Math.round(currentFraction * 100);

  section.innerHTML = `
    <div class="timeline-header">
      <h3>🌤 Weather Ahead</h3>
      <p>${live ? 'Weather relative to your live position' : 'Weather conditions along your route'}</p>
    </div>
    <div class="timeline" id="journey-timeline">
      <div class="timeline-line">
        <div class="timeline-line-fill" id="timeline-fill"></div>
      </div>
      ${checkpoints.map(cp => renderTimelineNode(cp)).join('')}
    </div>
    <div class="timeline-detail" id="timeline-detail"></div>
  `;

  const isMobile = window.innerWidth < 768;
  requestAnimationFrame(() => {
    const fill = document.getElementById('timeline-fill');
    if (fill) {
      fill.style.width = fillPct + '%';
      if (isMobile) {
        fill.style.height = fillPct + '%';
        fill.style.width = '100%';
      }
    }
  });

  document.querySelectorAll('.timeline-node').forEach(node => {
    node.addEventListener('click', () => {
      const idx = parseInt(node.dataset.index);
      showTimelineDetail(checkpoints[idx]);
    });
  });
}

function renderTimelineNode(cp) {
  const weatherContent = cp.weather && !cp.weather.error ? (cp.repeatedWeather ? `
    <div class="timeline-weather repeated">
      <span class="weather-icon">${cp.weather.conditionIcon || '🌤️'}</span>
      <span class="temp">${cp.weather.temperature != null ? Math.round(cp.weather.temperature) + '°C' : ''}</span>
      <span class="condition">same as previous</span>
      ${cp.riskTag || ''}
    </div>
  ` : `
    <div class="timeline-weather">
      <span class="weather-icon">${cp.weather.conditionIcon || '🌤️'}</span>
      <span class="temp">${cp.weather.temperature != null ? Math.round(cp.weather.temperature) + '°C' : ''}</span>
      <span class="condition">${cp.weather.condition || ''}</span>
      ${cp.weather.precipitation != null && cp.weather.precipitation > 0 ?
      `<span class="precip">Rain: ${(cp.weather.hourly?.[0]?.precipitationProbability ?? 0)}%</span>` : ''}
      ${cp.riskTag || ''}
    </div>
  `) : `
    <div class="timeline-weather">
      <span class="timeline-unavailable">Weather data unavailable</span>
    </div>
  `;

  const transitionChip = cp.transitionText ? `
    <div class="tl-change ${cp.transitionWorsens ? 'worsening' : ''}">${cp.transitionWorsens ? '▲' : '▼'} ${escapeHtml(cp.transitionText)}</div>
  ` : '';

  let dotInner = '';
  if (cp.state === 'current') dotInner = '<span class="timeline-car">🚗</span>';
  else if (cp.state === 'completed') dotInner = '<span class="timeline-check">✓</span>';
  else if (cp.weather && !cp.weather.error && cp.weather.conditionIcon) dotInner = `<span class="timeline-weatherdot">${cp.weather.conditionIcon}</span>`;

  const hereBadge = cp.state === 'current'
    ? '<span class="timeline-here">You are here</span>'
    : '';

  const locationText = cp.state === 'current' && !cp.isStart && cp.name
    ? `<span class="timeline-loc-name">${escapeHtml(cp.name)}</span>`
    : escapeHtml(cp.name);

  return `
    <div class="timeline-node ${liveMode ? 'live' : 'plan'} state-${cp.state || 'upcoming'} ${cp.isStart ? 'is-start' : ''} ${cp.isEnd ? 'is-end' : ''}" data-index="${cp.index}">
      <div class="timeline-dot ${cp.isStart ? 'start' : cp.isEnd ? 'end' : ''} risk-${cp.riskLevel}">${dotInner}</div>
      <div class="timeline-info">
        <div class="timeline-location">${locationText}${hereBadge}</div>
        <div class="timeline-distance">${cp.distanceText}</div>
        ${weatherContent}
        ${transitionChip}
        <div class="timeline-eta">${cp.etaText}</div>
      </div>
    </div>
  `;
}

function showTimelineDetail(checkpoint) {
  const detail = document.getElementById('timeline-detail');
  if (!detail) return;

  if (selectedTimelineIndex === checkpoint.index) {
    detail.classList.remove('show');
    selectedTimelineIndex = null;
    return;
  }

  selectedTimelineIndex = checkpoint.index;
  const w = checkpoint.weather;

  const rows = [];
  if (w && !w.error) {
    rows.push({ label: 'Condition', value: `${w.conditionIcon || ''} ${w.condition || 'Unknown'}` });
    if (w.arrivalTime) {
      const at = new Date(w.arrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      rows.push({ label: 'Forecast for', value: `${at} (arrival)` });
    }
    if (w.temperature != null) rows.push({ label: 'Temperature', value: `${Math.round(w.temperature)}°C` });
    if (w.precipitation != null) rows.push({ label: 'Precipitation', value: `${w.precipitation.toFixed(1)} mm` });
    if (w.hourly?.[0]?.precipitationProbability != null) rows.push({ label: 'Rain probability', value: `${w.hourly[0].precipitationProbability}%` });
    if (w.windSpeed != null) rows.push({ label: 'Wind speed', value: `${Math.round(w.windSpeed)} km/h` });
    if (w.visibility != null) rows.push({ label: 'Visibility', value: w.visibility > 1000 ? `${(w.visibility / 1000).toFixed(1)} km` : `${Math.round(w.visibility)} m` });
    rows.push({ label: 'Risk level', value: checkpoint.riskLevel.charAt(0).toUpperCase() + checkpoint.riskLevel.slice(1) });
  }

  const evidence = currentRisk?.details[checkpoint.index]?.evidence || [];
  const noteText = w && !w.error ?
    (evidence.length > 0 ? `Evidence: ${evidence.join('; ')}` : `Weather appears ${w.condition || 'calm'} at this route segment.`) +
    (w.forecastUnavailable ? ' Forecast is only available for roughly the next 48 hours — conditions beyond that may differ.' : '') :
    'Weather data unavailable for this segment.';

  detail.innerHTML = `
    <div class="timeline-detail-header">
      <h4>${escapeHtml(checkpoint.name || checkpoint.distanceText)} · ${checkpoint.distanceText}</h4>
      <button class="timeline-detail-close" onclick="document.getElementById('timeline-detail').classList.remove('show')">✕</button>
    </div>
    <div class="timeline-detail-grid">
      ${rows.map(r => `
        <div class="timeline-detail-item">
          <span class="label">${r.label}</span>
          <span class="value">${r.value}</span>
        </div>
      `).join('')}
    </div>
    <div class="timeline-detail-note">${noteText}</div>
  `;

  detail.classList.add('show');
}

function formatETA(seconds) {
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `ETA ${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `ETA ${h}h ${m}m`;
}

/* ================= Live Journey / Vehicle Tracking ================= */

function hideSummaryForLive(on) {
  const rec = document.getElementById('rec-card');
  if (rec) rec.classList.toggle('hidden', on);
}

function handleLiveToggle() {
  if (travelMode === 'flight') {
    showError('Live tracking is for road journeys — it doesn\u2019t apply to Flight mode.');
    return;
  }
  if (!currentRoute) { showError('Analyze a route first to start live tracking.'); return; }
  if (!liveTracker) return;

  if (liveTracker.active || liveMode) {
    liveMode = false;
    lastLiveRenderIdx = -1;
    liveTracker.stop();
    document.getElementById('live-btn').textContent = 'Start live tracking';
    document.getElementById('follow-btn').classList.add('hidden');
    document.getElementById('follow-btn').classList.remove('active');
    setRouteLineVisibility('plan');
    renderTimeline();
    hideSummaryForLive(false);
    return;
  }

  liveMode = true;
  lastLiveRenderIdx = -1;
  liveTracker.start();
  hideSummaryForLive(true);
}

function findCurrentCheckpoint(fraction) {
  const cps = currentRouteWeather || [];
  let idx = 0;
  for (let i = 0; i < cps.length; i++) {
    if (cps[i].fraction <= fraction) idx = i;
  }
  return idx;
}

function renderLiveTimeline(fraction) {
  if (!currentRouteWeather || currentRouteWeather.length === 0) return;
  const idx = findCurrentCheckpoint(fraction);
  if (idx === lastLiveRenderIdx) return;
  lastLiveRenderIdx = idx;
  renderTimeline(fraction);
}

function handleLiveStatus(s) {
  const bar = document.getElementById('journey-status');
  const barWrap = document.getElementById('journey-bar');
  if (!bar || !barWrap) return;
  if (barWrap.classList.contains('hidden')) barWrap.classList.remove('hidden');

  const liveBtn = document.getElementById('live-btn');
  const followBtn = document.getElementById('follow-btn');

  switch (s.mode) {
    case 'prompt':
    case 'idle':
      bar.textContent = 'Enable location to start live tracking';
      if (liveMode) {
        liveMode = false;
        lastLiveRenderIdx = -1;
        setRouteLineVisibility('plan');
        renderTimeline();
        hideSummaryForLive(false);
      }
      if (liveBtn) liveBtn.textContent = 'Start live tracking';
      if (followBtn) { followBtn.classList.add('hidden'); followBtn.classList.remove('active'); }
      break;

    case 'seeking':
      bar.innerHTML = '<span class="live-dot pulse"></span>Acquiring GPS signal…';
      if (liveBtn) liveBtn.textContent = 'Stop tracking';
      break;

    case 'active': {
      const km = (s.remainingKm ?? 0).toFixed(1);
      const min = Math.round(s.remainingMin ?? 0);
      bar.innerHTML = `<span class="live-dot"></span>Live journey · <b>${km} km</b> · <b>${min} min</b> remaining`;
      if (liveBtn) liveBtn.textContent = 'Stop tracking';
      if (followBtn) followBtn.classList.remove('hidden');
      setRouteLineVisibility('live');
      if (s.fraction != null) {
        updateRouteProgress(s.fraction);
        renderLiveTimeline(s.fraction);
      }
      break;
    }

    case 'stale':
      bar.innerHTML = '<span class="live-dot warn"></span>Live tracking paused — reacquiring signal';
      break;

    case 'unavailable':
      bar.innerHTML = '<span class="live-dot warn"></span>Route planned · Live tracking unavailable';
      if (liveBtn) liveBtn.textContent = liveTracker && liveTracker.active ? 'Stop tracking' : 'Start live tracking';
      if (followBtn) followBtn.classList.add('hidden');
      if (!liveTracker || !liveTracker.active) {
        liveMode = false;
        lastLiveRenderIdx = -1;
        setRouteLineVisibility('plan');
        renderTimeline();
      }
      break;

    case 'complete':
      bar.innerHTML = `<span class="live-dot done"></span><span class="live-complete">✓ Journey complete — you've reached ${escapeHtml(liveTracker ? liveTracker.destName : 'your destination')}</span>`;
      if (liveBtn) liveBtn.textContent = 'Start live tracking';
      if (followBtn) { followBtn.classList.add('hidden'); followBtn.classList.remove('active'); }
      updateRouteProgress(1);
      renderLiveTimeline(1);
      break;
  }
}

function updateRouteProgress(fraction) {
  const geom = currentRoute?.route?.geometry;
  const src = map && map.getSource && map.getSource('progress');
  if (!geom || !src) return;

  const coords = geom.coordinates;
  const cache = getDistanceCache(geom);
  const totalKm = cache[cache.length - 1];
  if (totalKm <= 0) return;

  const targetKm = totalKm * clamp01(fraction);
  let i = 0;
  while (i < cache.length - 2 && cache[i + 1] < targetKm) i++;
  const segLenKm = cache[i + 1] - cache[i];
  const t = segLenKm > 0 ? (targetKm - cache[i]) / segLenKm : 0;
  const a = coords[i];
  const b = coords[i + 1];
  const snapped = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  const completed = [...coords.slice(0, i + 1), snapped];
  const remaining = [snapped, ...coords.slice(i + 1)];

  src.setData({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: completed }, properties: {} },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: remaining }, properties: {} }
    ]
  });
}

function setRouteLineVisibility(view) {
  if (!map || !map.getLayer) return;
  const plan = ['route-line-bg', 'route-line', 'route-line-segments'];
  const live = ['route-completed-line', 'route-remaining-line'];
  ['route-line-bg', 'route-line', 'route-line-segments', 'route-completed-line', 'route-remaining-line'].forEach(id => {
    if (!map.getLayer(id)) return;
    map.setLayoutProperty(id, 'visibility', (view === 'live' ? live : plan).includes(id) ? 'visible' : 'none');
  });
}

/* ================= Helpers / Voice / Errors ================= */

function setAnalyzing(val) {
  isAnalyzing = val;
  const btn = document.getElementById('analyze-btn');
  if (btn) {
    btn.disabled = val;
    btn.innerHTML = val ?
      '<div class="spinner"></div><span>Analyzing...</span>' :
      '<span>Analyze Route</span>';
  }
}

function showLoading(text) {
  const el = document.getElementById('map-loading');
  const txt = document.getElementById('loading-text');
  if (el) el.classList.add('show');
  if (txt) txt.textContent = text || 'Loading...';
}

function hideLoading() {
  const el = document.getElementById('map-loading');
  if (el) el.classList.remove('show');
}

function showError(msg) {
  const toast = document.getElementById('error-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  toast.classList.remove('severe');
  setTimeout(() => toast.classList.remove('show'), 6000);
}

function hideError() {
  const toast = document.getElementById('error-toast');
  if (toast) toast.classList.remove('show');
}

function setupVoiceRecognition() {
  updateVoiceDebug('status', 'Idle');
  updateVoiceDebug('provider', describeVoiceProvider());
}

function describeVoiceProvider() {
  const setup = getSTTSetup();
  if (!setup.active) return 'None';
  return setup.active.label;
}

function getVoiceLang() {
  return VOICE_LANGS[0] ? VOICE_LANGS[0].code : 'en-IN';
}

function setVoiceState(state) {
  voiceState = state || 'idle';
  updateVoiceDebug('status', voiceState.charAt(0).toUpperCase() + voiceState.slice(1));
}

function setListeningVisuals(on) {
  document.getElementById('voice-btn')?.classList.toggle('listening', on);
  const ov = document.getElementById('voice-overlay');
  if (ov) ov.classList.toggle('listening', on);
}

function setVoiceHint(text) {
  const el = document.getElementById('voice-hint');
  if (el) el.textContent = text || '';
}

function setVoiceStatus(text) {
  const el = document.getElementById('voice-status');
  if (el) el.textContent = text == null ? '' : text;
}

function resetVoiceCtx() {
  voiceCtx = {
    need: null,          // 'origin' | 'destination' | null
    origin: null,        // spoken/typed origin text or HERE_TOKEN
    originIsHere: false,
    originSel: null,     // resolved geocoder candidate
    dest: null,
    destSel: null,
    pending: null        // awaiting candidate pick: { which, res, text }
  };
}

function openVoice() {
  const ov = document.getElementById('voice-overlay');
  if (ov) ov.classList.add('active');
  const tr = document.getElementById('voice-transcript');
  if (tr) tr.textContent = '';
  document.getElementById('voice-retry-btn')?.classList.add('hidden');
  setVoiceView(null);
}

function startVoice() {
  if (voiceState !== 'idle') {
    teardownVoice(); // a second tap on the mic cancels
    return;
  }
  const setup = getSTTSetup();
  if (!setup.active) {
    showError('Voice search isn\u2019t available in this browser. Allow the microphone, or use typing.');
    return;
  }
  resetVoiceCtx();
  openVoice();
  setVoiceHint('Tell me where you\u2019re going');
  setVoiceStatus('Listening\u2026');
  beginListening();
}

/* Starts a brand-new recognition session. A fresh id is minted each call
   so results/errors from any previously cancelled turn are always dropped
   (session identity / stale-callback guard). */
function beginListening() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  voiceSession = null;
  const sid = ++voiceSessionId;
  setVoiceState('listening');
  setListeningVisuals(true);
  setVoiceView(null);

  const session = createSTTSession({
    lang: getVoiceLang(),
    onInterim: (partial) => {
      if (sid !== voiceSessionId) return;
      document.getElementById('voice-transcript').textContent = partial;
    },
    onFinal: (text) => {
      if (sid !== voiceSessionId) return;
      updateVoiceDebug('transcript', text);
      handleVoiceIntent(text, sid);
    },
    onEnd: () => {
      if (sid !== voiceSessionId) return;
      if (voiceSession === session) voiceSession = null;
      // Ended without delivering a final result -> silence.
      if (voiceState === 'listening') handleVoiceError('no-speech', sid);
    },
    onError: (code) => {
      if (sid !== voiceSessionId) return;
      handleVoiceError(code, sid);
    }
  });

  if (!session) {
    teardownVoice();
    showError('Voice search isn\u2019t available in this browser.');
    return;
  }

  voiceSession = session;
  session.start();
}

function handleVoiceError(code, sid) {
  if (sid != null && sid !== voiceSessionId) return;
  setListeningVisuals(false);

  if (code === 'aborted' || code === 'start-failed') {
    teardownVoice();
    return;
  }

  setVoiceState('error');
  setVoiceView(null);
  setVoiceHint('');

  const retry = document.getElementById('voice-retry-btn');
  if (code === 'not-allowed') {
    setVoiceStatus('Microphone access is blocked. You can still enter your route manually.');
  } else if (code === 'no-speech') {
    setVoiceStatus('I couldn\u2019t hear that. Try again.');
    if (retry) retry.classList.remove('hidden');
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (voiceState === 'error') beginListening();
    }, 1500);
  } else if (code === 'audio-capture') {
    setVoiceStatus('No microphone found. Check your audio input.');
    if (retry) retry.classList.remove('hidden');
  } else if (code === 'network') {
    setVoiceStatus('Voice service is unavailable. Please try again.');
    if (retry) retry.classList.remove('hidden');
  } else if (code === 'unsupported') {
    setVoiceStatus('This language isn\u2019t supported by your speech service.');
  } else {
    setVoiceStatus('Voice search isn\u2019t available right now.');
    if (retry) retry.classList.remove('hidden');
  }
}

/* Single cleanup path for EVERY exit: cancel, close, completion, error.
   Invalidates all pending work and fully frees the microphone. */
function teardownVoice() {
  voiceSessionId++;
  if (voiceSession) {
    try { voiceSession.stop({ cancel: true }); } catch { /* ignore */ }
    voiceSession = null;
  }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  resetVoiceCtx();
  setVoiceState('idle');
  setListeningVisuals(false);
  const ov = document.getElementById('voice-overlay');
  if (ov) ov.classList.remove('active', 'listening');
  const tr = document.getElementById('voice-transcript');
  if (tr) tr.textContent = '';
  setVoiceHint('');
  setVoiceStatus('');
  document.getElementById('voice-retry-btn')?.classList.add('hidden');
  setVoiceView(null);
}

function restartVoice() {
  setVoiceView(null);
  document.getElementById('voice-retry-btn')?.classList.add('hidden');
  setVoiceHint('Tell me where you\u2019re going');
  setVoiceStatus('Listening\u2026');
  beginListening();
}

function updateVoiceDebug(field, value) {
  const ids = {
    status: 'vd-status',
    provider: 'vd-provider',
    language: 'vd-language',
    transcript: 'vd-transcript',
    origin: 'vd-origin',
    dest: 'vd-dest',
    geo: 'vd-geo',
    conf: 'vd-conf'
  };
  const el = document.getElementById(ids[field]);
  if (el) el.textContent = value == null || value === '' ? '—' : String(value);
}

function handleVoiceIntent(text, sid) {
  if (sid != null && sid !== voiceSessionId) return;

  const nlu = parseVoiceIntent(text, {
    currentMode: currentOriginMode === 'current' && !!currentLocation
  });

  addDevLog(`[voice] RAW: ${text}`);
  addDevLog(`[voice] INTENT: ${nlu.kind}${nlu.origin ? ' origin=' + nlu.origin : ''}${nlu.originIsHere ? ' origin=(here)' : ''}${nlu.destination ? ' dest=' + nlu.destination : ''}${nlu.place ? ' place=' + nlu.place : ''}${nlu.mode ? ' mode=' + nlu.mode : ''} conf=${nlu.confidence || '?'}`);

  updateVoiceDebug('transcript', text);
  updateVoiceDebug('origin', nlu.origin ? (nlu.origin === HERE_TOKEN ? '(current location)' : nlu.origin) : (nlu.place === HERE_TOKEN ? '(current location)' : (nlu.place || null)));
  updateVoiceDebug('dest', nlu.destination || null);
  updateVoiceDebug('geo', null);
  updateVoiceDebug('conf', nlu.confidence || null);

  // Apply travel mode whenever it was mentioned in the sentence.
  if (nlu.kind !== 'correction' && nlu.mode) selectTravelMode(nlu.mode);

  setVoiceState('understanding');
  setVoiceStatus('Got it \u2014 checking places\u2026');

  if (nlu.kind === 'correction') {
    applyVoiceCorrection(nlu, sid);
    return;
  }

  if (nlu.kind === 'ambiguous') {
    voiceAmbiguousPlaces = nlu.places;
    showVoiceAmbiguous(nlu.places);
    return;
  }

  if (nlu.kind === 'none') {
    failVoice(sid, 'I couldn\u2019t catch a place name. Try again.');
    return;
  }

  // A field is missing and we already asked for it -> consume this reply.
  if (voiceCtx && voiceCtx.need) {
    handlePendingNeed(nlu, sid);
    return;
  }

  if (nlu.kind === 'route') {
    resolveAndApply(nlu.origin, nlu.destination, sid);
    return;
  }

  if (nlu.kind === 'dest-only' || nlu.kind === 'single') {
    const place = nlu.place;
    if (place == null || place === HERE_TOKEN) {
      failVoice(sid, 'Where would you like to go? Say the destination.');
      return;
    }
    if (currentOriginMode === 'current' && currentLocation) {
      resolveAndApply(HERE_TOKEN, place, sid);
      return;
    }
    const typedOrigin = document.getElementById('origin-input').value.trim();
    if (typedOrigin) {
      resolveAndApply(typedOrigin, place, sid);
      return;
    }
    voiceCtx.dest = place;
    promptFor('origin', sid);
    return;
  }

  if (nlu.kind === 'origin-only') {
    const place = nlu.place;
    if (place === HERE_TOKEN) {
      if (currentOriginMode !== 'current') setCurrentOriginMode('current');
      if (!currentLocation) {
        failVoice(sid, 'Still locating your position \u2014 try again in a moment.');
        return;
      }
      const typedDest = document.getElementById('dest-input').value.trim();
      if (typedDest) { resolveAndApply(HERE_TOKEN, typedDest, sid); return; }
      promptFor('destination', sid);
      return;
    }
    voiceCtx.origin = place;
    const typedDest = document.getElementById('dest-input').value.trim();
    if (typedDest) { resolveAndApply(place, typedDest, sid); return; }
    promptFor('destination', sid);
    return;
  }

  failVoice(sid, 'I couldn\u2019t understand that. Try again.');
}

function failVoice(sid, message) {
  if (sid != null && sid !== voiceSessionId) return;
  setVoiceState('error');
  setVoiceView(null);
  setVoiceHint('');
  setVoiceStatus(message);
  document.getElementById('voice-retry-btn')?.classList.remove('hidden');
}

function promptFor(need, sid) {
  if (sid != null && sid !== voiceSessionId) return;
  voiceCtx.need = need;
  setVoiceHint(need === 'origin' ? 'Where are you starting from?' : 'Where would you like to go?');
  setVoiceStatus('Listening\u2026');
  beginListening();
}

function handlePendingNeed(nlu, sid) {
  const need = voiceCtx.need;

  if (nlu.kind === 'correction') {
    applyVoiceCorrection(nlu, sid);
    return;
  }

  // A complete route overrides any pending prompt.
  if (nlu.kind === 'route') {
    voiceCtx.need = null;
    resolveAndApply(nlu.origin, nlu.destination, sid);
    return;
  }

  let value = null;
  if (nlu.kind === 'origin-only' || nlu.kind === 'dest-only' || nlu.kind === 'single') {
    value = nlu.place;
  }

  if (value === HERE_TOKEN) {
    if (need === 'origin' && currentOriginMode === 'current' && currentLocation) {
      voiceCtx.need = null;
      resolveAndApply(HERE_TOKEN, voiceCtx.dest, sid);
    } else {
      failVoice(sid, 'I didn\u2019t catch a place name. Try again.');
    }
    return;
  }
  if (value == null) {
    failVoice(sid, 'I didn\u2019t catch a place name. Try again.');
    return;
  }

  if (need === 'origin') {
    const dest = voiceCtx.dest;
    voiceCtx.need = null;
    voiceCtx.origin = value;
    resolveAndApply(value, dest, sid);
  } else {
    const origin = voiceCtx.origin;
    voiceCtx.need = null;
    voiceCtx.dest = value;
    resolveAndApply(origin, value, sid);
  }
}

function applyVoiceCorrection(correction, sid) {
  if (sid != null && sid !== voiceSessionId) return;

  if (correction.field === 'mode') {
    selectTravelMode(correction.value);
    const label = MODES[correction.value] ? MODES[correction.value].label : correction.value;
    setVoiceStatus(`Travel mode set to ${label}. Where are you going?`);
    setVoiceHint('Tell me where you\u2019re going');
    beginListening();
    return;
  }

  const field = correction.field === 'origin' ? 'origin' : 'destination';
  const value = correction.value || '';
  const valueIsHere = /^(here|current ?location|my location|location)$/i.test(value);

  if (valueIsHere) {
    if (field !== 'origin') {
      failVoice(sid, 'Say the destination city name.');
      return;
    }
    if (currentOriginMode !== 'current') setCurrentOriginMode('current');
    if (!currentLocation) {
      failVoice(sid, 'Still locating your position \u2014 try again in a moment.');
      return;
    }
    voiceCtx.originIsHere = true;
    const dest = voiceCtx.dest || document.getElementById('dest-input').value.trim();
    if (dest) { resolveAndApply(HERE_TOKEN, dest, sid); return; }
    promptFor('destination', sid);
    return;
  }

  if (field === 'origin') {
    voiceCtx.origin = value;
    voiceCtx.originIsHere = false;
    const dest = voiceCtx.dest || document.getElementById('dest-input').value.trim();
    if (dest) { resolveAndApply(value, dest, sid); return; }
    promptFor('destination', sid);
    return;
  }

  voiceCtx.dest = value;
  const typedOrigin = document.getElementById('origin-input').value.trim();
  const origin = (currentOriginMode === 'current' && currentLocation) ? HERE_TOKEN : (voiceCtx.origin || typedOrigin || null);
  if (origin) { resolveAndApply(origin, value, sid); return; }
  promptFor('origin', sid);
}

function showVoiceAmbiguous(places) {
  const box = document.getElementById('vc-ambiguous');
  const labels = places.map(p => (p && p.trim()) ? p : 'a place');
  box.innerHTML = `
    <button type="button" class="vc-opt selected" data-a="0" data-b="1">
      <span class="loc-pin">📍</span>
      <span class="loc-main"><span class="loc-direction">${escapeHtml(labels[0])} → ${escapeHtml(labels[1])}</span></span>
    </button>
    <button type="button" class="vc-opt" data-a="1" data-b="0">
      <span class="loc-pin">🔁</span>
      <span class="loc-main"><span class="loc-direction">${escapeHtml(labels[1])} → ${escapeHtml(labels[0])}</span></span>
    </button>`;
  setVoiceStatus('Which way are you travelling?');
  setVoiceView('ambiguous');
}

/* Brief, button-free confirmation before returning to the form. */
function flashRouteSet(originName, destName, sid) {
  if (sid == null) sid = voiceSessionId;
  if (sid !== voiceSessionId) return;
  document.getElementById('vp-origin').textContent = `📍 ${originName}`;
  document.getElementById('vp-dest').textContent = `📍 ${destName}`;
  setVoiceView('route');
  setVoiceHint('');
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (sid !== voiceSessionId) return;
    const msg = `${originName} → ${destName}`;
    teardownVoice();
    showVoiceToast(`Route set: ${msg}. Press Analyze Route.`);
  }, 900);
}

function setVoiceView(name) {
  document.getElementById('voice-view-route').classList.toggle('hidden', name !== 'route');
  document.getElementById('voice-view-confirm').classList.toggle('hidden', name !== 'confirm');
  document.getElementById('voice-view-ambiguous').classList.toggle('hidden', name !== 'ambiguous');
  document.getElementById('voice-panel').classList.toggle('hidden', !name);
}



async function resolveAndApply(originSpec, destSpec, sid) {
  const originIsHere = originSpec === HERE_TOKEN;
  if (originIsHere && !currentLocation) {
    if (currentOriginMode === 'current') {
      failVoice(sid, 'Still locating your position \u2014 try again in a moment.');
    } else {
      failVoice(sid, 'I need your location. Enable \u201CUse my current location\u201D or say your starting city.');
    }
    return;
  }

  // Snapshot the current edit sequences so a slow geocoder response can never
  // overwrite a field the user has since edited (stale-voice protection).
  const originInput = document.getElementById('origin-input');
  const destInput = document.getElementById('dest-input');
  const originSeq = originInput ? (originInput._editSeq || 0) : 0;
  const destSeq = destInput ? (destInput._editSeq || 0) : 0;

  setVoiceState('understanding');
  setVoiceStatus('Checking places\u2026');

  try {
    const originTask = originIsHere
      ? Promise.resolve({ status: 'resolved', selection: { ...currentLocation, placeName: currentLocation.shortName || 'Your current location', shortName: currentLocation.shortName || 'Your current location' }, match: 'current' })
      : resolveLocationText(originSpec);
    const destTask = destSpec ? resolveLocationText(destSpec) : Promise.resolve({ status: 'none' });
    const [oRes, dRes] = await Promise.all([originTask, destTask]);

    if (sid != null && sid !== voiceSessionId) return;

    addDevLog(`[voice] ORIGIN geocode: ${oRes.status}${oRes.selection ? ' \u2192 ' + oRes.selection.placeName : ''}${oRes.match ? ` (${oRes.match})` : ''}`);
    addDevLog(`[voice] DEST geocode: ${dRes.status}${dRes.selection ? ' \u2192 ' + dRes.selection.placeName : ''}${dRes.match ? ` (${dRes.match})` : ''}`);

    voiceCtx.origin = originIsHere ? HERE_TOKEN : originSpec;
    voiceCtx.originIsHere = originIsHere;
    voiceCtx.dest = destSpec || null;
    if (oRes.status === 'resolved') voiceCtx.originSel = oRes.selection;
    if (dRes.status === 'resolved') voiceCtx.destSel = dRes.selection;
    updateVoiceDebug('geo', `${oRes.status}/${dRes.status}`);
    updateVoiceDebug('conf', `${oRes.match || oRes.status} / ${dRes.match || dRes.status}`);

    if (oRes.status === 'resolved' && dRes.status === 'resolved') {
      const okOrigin = applyField('origin', oRes.selection, originIsHere, originSeq);
      const okDest = applyField('dest', dRes.selection, false, destSeq);
      if (okOrigin || okDest) tryCompleteVoice(sid);
      return;
    }
    if (oRes.status === 'error' || dRes.status === 'error') {
      failVoice(sid, 'Location search is temporarily unavailable. Please try again.');
      return;
    }
    if (oRes.status === 'none' || dRes.status === 'none') {
      const missing = oRes.status !== 'resolved' ? originSpec : destSpec;
      failVoice(sid, `I couldn\u2019t find \u201C${missing}\u201D. Try saying it again, or type it below.`);
      return;
    }

    // Apply whichever side already resolved now, so a confirmation round-trip
    // never leaves the other field empty (the pending side is filled when the
    // user picks a candidate).
    if (oRes.status === 'resolved' && (dRes.status === 'suggest' || dRes.status === 'none')) {
      applyField('origin', oRes.selection, originIsHere, originSeq);
    }
    if (dRes.status === 'resolved' && (oRes.status === 'suggest' || oRes.status === 'none')) {
      applyField('dest', dRes.selection, false, destSeq);
    }

    const pending = oRes.status !== 'resolved'
      ? { which: 'origin', res: oRes, text: originSpec }
      : { which: 'dest', res: dRes, text: destSpec };
    voiceCtx.pending = pending;
    setVoiceState('confirmation');
    showVoiceConfirm(pending);
  } catch {
    if (sid != null && sid !== voiceSessionId) return;
    failVoice(sid, 'Something went wrong while finding those places. Please try again.');
  }
}

/* Applies a resolved candidate to a field. `expectedSeq` is the field's edit
   sequence captured when the (possibly async) voice resolution started; if the
   user has since edited the field, the write is refused so a stale voice result
   can never silently overwrite a newer manual choice. Returns true when applied. */
function applyField(which, candidate, isHere, expectedSeq) {
  const input = which === 'origin' ? document.getElementById('origin-input') : document.getElementById('dest-input');
  const seq = input ? (input._editSeq || 0) : 0;
  if (expectedSeq != null && seq !== expectedSeq) {
    addDevLog(`[voice] skipped stale ${which} write (editSeq ${seq} !== ${expectedSeq})`);
    return false;
  }

  if (which === 'origin') {
    if (isHere) {
      if (currentOriginMode !== 'current') setCurrentOriginMode('current');
      input.value = '';
      input._selection = currentLocation ? { ...currentLocation } : null;
    } else {
      input.value = selectionDisplay(candidate);
      input._selection = candidate;
    }
  } else {
    input.value = selectionDisplay(candidate);
    input._selection = candidate;
  }
  if (input) {
    input._editSeq = seq + 1;
    input._selectionVersion = (input._selectionVersion || 0) + 1;
  }
  markRouteStale(true);
  return true;
}

function tryCompleteVoice(sid) {
  const oReady = voiceCtx.originIsHere ? !!currentLocation : !!voiceCtx.originSel;
  const dReady = !!voiceCtx.destSel;
  if (!oReady || !dReady) return;
  const originName = voiceCtx.originIsHere
    ? (currentLocation && currentLocation.shortName ? `Your current location \u00B7 ${currentLocation.shortName}` : 'Your current location')
    : (voiceCtx.originSel ? voiceCtx.originSel.placeName : voiceCtx.origin);
  const destName = voiceCtx.destSel ? voiceCtx.destSel.placeName : voiceCtx.dest;
  flashRouteSet(originName, destName, sid);
}

function showVoiceConfirm(pending) {
  const box = document.getElementById('vc-suggestion');
  const title = document.getElementById('vp-confirm-title');

  if (!pending.res.suggestions || pending.res.suggestions.length === 0) {
    title.textContent = 'I couldn\u2019t find that place';
    box.innerHTML = `<div class="vc-none">No matching places for \u201C${escapeHtml(pending.text)}\u201D. Try again with a clearer pronunciation, or type it below.</div>`;
    setVoiceView('confirm');
    return;
  }

  title.textContent = pending.res.didYouMean
    ? 'Did you mean?'
    : (pending.res.ambiguous ? 'Which place did you mean?' : 'Which one did you mean?');

  box.innerHTML = pending.res.suggestions.slice(0, 3).map((c, i) => `
    <button type="button" class="vc-opt ${i === 0 ? 'selected' : ''}" data-idx="${i}">
      <span class="loc-pin">📍</span>
      <span class="loc-main">
        <span class="loc-name">${escapeHtml(c.placeName || c.displayName.split(',')[0])}</span>
        ${c.region ? `<span class="loc-region">${escapeHtml(c.region)}</span>` : ''}
      </span>
      ${i === 0 ? '<span class="loc-badge ok">best</span>' : ''}
    </button>`).join('');

  box.querySelectorAll('.vc-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      box.querySelectorAll('.vc-opt').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  setVoiceView('confirm');
}

function confirmVoicePlace() {
  const pending = voiceCtx && voiceCtx.pending;
  if (!pending) return;
  const box = document.getElementById('vc-suggestion');
  const selected = box.querySelector('.vc-opt.selected');
  const idx = selected ? parseInt(selected.dataset.idx, 10) : 0;
  const c = (pending.res.suggestions || [])[idx];
  const sid = voiceSessionId;
  if (!c) {
    failVoice(sid, 'I couldn\u2019t find that place. Try again or type it below.');
    return;
  }
  applyField(pending.which, c);
  if (pending.which === 'origin') voiceCtx.originSel = c;
  else voiceCtx.destSel = c;
  voiceCtx.pending = null;

  const oReady = voiceCtx.originIsHere ? !!currentLocation : !!voiceCtx.originSel;
  const dReady = !!voiceCtx.destSel;
  if (!oReady) {
    promptFor('origin', sid);
    return;
  }
  if (!dReady) {
    promptFor('destination', sid);
    return;
  }
  tryCompleteVoice(sid);
}

function showVoiceToast(msg) {
  const toast = document.getElementById('error-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('success', 'show');
  if (voiceToastTimer) clearTimeout(voiceToastTimer);
  voiceToastTimer = setTimeout(() => {
    toast.classList.remove('show', 'success');
    voiceToastTimer = null;
  }, 3500);
}

let resizeFitTimer = null;
window.addEventListener('resize', () => {
  if (map) map.resize();
  const routeGeo = currentRoute && currentRoute.route && currentRoute.route.geometry;
  if (window.innerWidth < 600 && routeGeo && routeGeo.coordinates && routeGeo.coordinates.length) {
    clearTimeout(resizeFitTimer);
    resizeFitTimer = setTimeout(() => {
      if (map && currentRoute && currentRoute.route.geometry.coordinates) {
        map.resize();
        fitMapToRoute(currentRoute.route.geometry);
      }
    }, 350);
  }
});