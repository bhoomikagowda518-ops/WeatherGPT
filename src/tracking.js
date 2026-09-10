import { snapPointToRoute, nextSegmentBearing } from './routing.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const wrap360 = (deg) => ((deg % 360) + 360) % 360;

const VEHICLE_SVG = `
  <svg class="vehicle-icon" width="38" height="38" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <circle cx="20" cy="20" r="18.5" fill="rgba(139,124,246,0.14)" stroke="rgba(139,124,246,0.4)" stroke-width="1.5"/>
    <path d="M20 4.5 C14.5 12.5 9.5 18.5 9.5 24.5 C9.5 30.5 14.2 35 20 35 C25.8 35 30.5 30.5 30.5 24.5 C30.5 18.5 25.5 12.5 20 4.5 Z"
          fill="#8B7CF6" stroke="#FFFFFF" stroke-width="2.2"/>
    <path d="M20 13 L15.4 18 L15.4 20.6 L24.6 20.6 L24.6 18 Z" fill="#FFFFFF" opacity="0.92"/>
    <path d="M15.4 20.6 L15.4 25 L24.6 25 L24.6 20.6 Z" fill="#6E5FE0"/>
    <rect x="11.6" y="24.8" width="4.2" height="6.6" rx="1.6" fill="#1E1B2E"/>
    <rect x="24.2" y="24.8" width="4.2" height="6.6" rx="1.6" fill="#1E1B2E"/>
    <circle cx="17.2" cy="9.2" r="1.5" fill="#FFFFFF"/>
    <circle cx="22.8" cy="9.2" r="1.5" fill="#FFFFFF"/>
  </svg>`;

export class LiveTracker {
  constructor() {
    this.map = null;
    this.geometry = null;
    this.totalDistanceM = 0;
    this.totalDurationSec = 0;
    this.destName = '';

    this.watchId = null;
    this.active = false;
    this.hasFix = false;
    this.mode = 'idle';
    this.reason = '';

    this.fraction = 0;
    this.speed = 0;
    this.lastSignalRadiusM = 0;

    this.displayLat = 0;
    this.displayLng = 0;
    this.displayHeading = 0;
    this.targetLat = 0;
    this.targetLng = 0;
    this.targetHeading = 0;

    this.follow = false;
    this.followLast = 0;
    this.lastFixAt = 0;

    this.marker = null;
    this.iconEl = null;
    this.pulseEl = null;

    this.frame = null;
    this.lastTs = null;
    this.lastOnStatusRun = 0;

    this.onStatus = null;
  }

  setMap(map) {
    this.map = map;
  }

  setRoute({ geometry, totalDistance, totalDuration, destName }) {
    this.geometry = geometry || null;
    this.totalDistanceM = totalDistance || 0;
    this.totalDurationSec = totalDuration || 0;
    this.destName = destName || '';
    this.beginStop();
    this._resetState();
    this.setMode('prompt', '');
    this._hideMarker();
  }

  _resetState() {
    this.hasFix = false;
    this.fraction = 0;
    this.speed = 0;
    this.lastSignalRadiusM = 0;
    this.follow = false;
    this.displayLat = 0;
    this.displayLng = 0;
    this.displayHeading = 0;
    this.targetLat = 0;
    this.targetLng = 0;
    this.targetHeading = 0;
  }

  get activeRoute() {
    return !!(this.geometry && this.geometry.coordinates && this.geometry.coordinates.length >= 2);
  }

  createMarker() {
    if (!this.map || this.marker) return;
    const el = document.createElement('div');
    el.className = 'vehicle-marker';
    el.innerHTML = `<div class="vehicle-pulse"></div>${VEHICLE_SVG}`;
    this.iconEl = el.querySelector('.vehicle-icon');
    this.pulseEl = el.querySelector('.vehicle-pulse');
    this.marker = new maplibregl.Marker({
      element: el,
      anchor: 'center',
      rotationAlignment: 'map',
      pitchAlignment: 'map'
    }).addTo(this.map);
    this._hideMarker();
  }

  removeMarker() {
    if (this.marker) {
      this.marker.remove();
      this.marker = null;
      this.iconEl = null;
      this.pulseEl = null;
    }
  }

  start() {
    if (!this.activeRoute || this.active) return;
    if (!navigator.geolocation) {
      this.setMode('unavailable', 'Geolocation is not supported by this browser. Live tracking unavailable.');
      return;
    }
    this.active = true;
    this._resetState();
    this.setMode('seeking', '');
    this.createMarker();
    this._startLoop();
    this.watchId = navigator.geolocation.watchPosition(
      this._onGeo,
      this._onGeoError,
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
    );
  }

  stop() {
    this.beginStop();
    this._hideMarker();
    if (this.geometry) this.setMode('prompt', '');
  }

  beginStop() {
    this.active = false;
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this._stopLoop();
  }

  setFollow(value) {
    this.follow = !!value;
  }

  toggleFollow() {
    this.follow = !this.follow;
    return this.follow;
  }

  setMode(mode, reason) {
    this.mode = mode;
    this.reason = reason || '';
    this._emitStatus({});
  }

  _onGeo = (pos) => {
    if (!this.active) return;
    const c = pos.coords;
    const lat = c.latitude;
    const lng = c.longitude;
    const speed = (c.speed != null && c.speed >= 0) ? c.speed : null;
    const heading = (c.heading != null) ? c.heading : null;

    const snapped = snapPointToRoute(this.geometry, lat, lng);
    const currentSpeed = speed != null ? speed : this.speed;
    this.speed = currentSpeed;
    this.lastSignalRadiusM = snapped.distanceFromRouteM;

    // GPS heading is only reliable while actually moving.
    const moving = currentSpeed > 0.5 || speed == null;
    let geometryHeading = nextSegmentBearing(this.geometry, snapped);

    let targetHeading;
    let headingSource;
    if (heading != null && heading > 0 && moving) {
      const diff = Math.abs(((heading - geometryHeading + 540) % 360) - 180);
      // At high speed trust the sensor; at low-moderate speed prefer the road direction
      // when the sensor disagrees wildly (avoids GPS heading noise).
      if (currentSpeed > 8 || diff < 60) {
        targetHeading = heading;
        headingSource = 'gps';
      } else {
        targetHeading = geometryHeading;
        headingSource = 'route';
      }
    } else {
      targetHeading = geometryHeading;
      headingSource = 'route';
    }

    this.targetHeading = targetHeading;
    this.targetLat = snapped.lat;
    this.targetLng = snapped.lng;
    this.fraction = snapped.fraction;
    this.hasFix = true;
    this.lastFixAt = Date.now();

    this.createMarker();
    this._showMarker();

    if (this.mode !== 'active') this.setMode('active', '');

    if (this.fraction >= 0.99) {
      this.beginStop();
      this.setMode('complete', '');
      this._emitStatus({ fraction: 1, remainingKm: 0, remainingMin: 0 });
      return;
    }

    const remainingKm = Math.max(0, (1 - snapped.fraction) * this.totalDistanceM / 1000);
    const remainingMin = Math.max(0, (1 - snapped.fraction) * this.totalDurationSec / 60);
    this._emitStatus({
      fraction: snapped.fraction,
      remainingKm,
      remainingMin,
      headingSource,
      offRoute: snapped.distanceFromRouteM
    });
  };

  _onGeoError = (err) => {
    if (!this.active) return;
    if (err && err.code === 1) {
      this.beginStop();
      this.setMode('unavailable', 'Location permission denied. Live tracking unavailable.');
      return;
    }
    if (this.hasFix) {
      this.setMode('stale', 'Signal lost — keeping last known position');
    } else {
      this.setMode('unavailable', 'Live tracking unavailable.');
    }
  };

  _startLoop() {
    if (this.frame) return;
    this.lastTs = null;
    const loop = (ts) => {
      if (!this.active) {
        this.frame = null;
        return;
      }
      if (this.lastTs != null && this.hasFix) {
        const dt = Math.min(ts - this.lastTs, 120);
        this._update(dt);
      }
      this.lastTs = ts;
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  _stopLoop() {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  _update(dt) {
    const kPos = 1 - Math.exp(-dt / 400);
    const kHead = 1 - Math.exp(-dt / 650);

    this.displayLat += (this.targetLat - this.displayLat) * kPos;
    this.displayLng += (this.targetLng - this.displayLng) * kPos;

    // Circular interpolation: always turn the shortest way around.
    let d = ((this.targetHeading - this.displayHeading + 540) % 360) - 180;
    if (this.speed <= 0.5 && Math.abs(d) > 120) {
      // Stationary: never spin the long way; ease very gently.
      d *= 0.04;
    }
    this.displayHeading = wrap360(this.displayHeading + d * kHead);

    if (this.marker) {
      this.marker.setLngLat([this.displayLng, this.displayLat]);
      if (this.iconEl) {
        this.iconEl.style.transform = `rotate(${this.displayHeading.toFixed(1)}deg)`;
      }
    }

    if (this.follow && this.map) {
      const now = Date.now();
      if (now - this.followLast > 200) {
        this.followLast = now;
        this.map.easeTo({
          center: [this.displayLng, this.displayLat],
          zoom: Math.max(12, this.map.getZoom()),
          duration: 400,
          essential: true
        });
      }
    }

    if (this.hasFix && this.lastFixAt && Date.now() - this.lastFixAt > 20000 && this.mode === 'active') {
      this.setMode('stale', 'Signal lost — keeping last known position');
    }
  }

  _emitStatus(extra) {
    if (!this.onStatus) return;
    this.onStatus({ mode: this.mode, reason: this.reason, ...extra });
  }

  _showMarker() {
    if (this.marker) this.marker.getElement().style.display = 'block';
  }

  _hideMarker() {
    if (this.marker) this.marker.getElement().style.display = 'none';
  }
}