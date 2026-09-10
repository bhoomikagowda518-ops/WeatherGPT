let lastAlertId = null;
let lastVibrationTime = 0;
const COOLDOWN_MS = 300000;

const alertListeners = [];

export function onAlert(callback) {
  alertListeners.push(callback);
  return () => {
    const idx = alertListeners.indexOf(callback);
    if (idx >= 0) alertListeners.splice(idx, 1);
  };
}

function emitAlert(alertData) {
  for (const fn of alertListeners) {
    try { fn(alertData); } catch {}
  }
}

export function triggerSevereAlert(alertData) {
  const id = `${alertData.level}-${alertData.condition}-${Math.round(Date.now() / 60000)}`;
  if (id === lastAlertId) return { triggered: false, reason: 'duplicate' };

  const vibrationSupported = 'vibrate' in navigator;
  let vibrationTriggered = false;
  const now = Date.now();
  const withinCooldown = (now - lastVibrationTime) < COOLDOWN_MS;

  if (vibrationSupported && !withinCooldown) {
    try {
      navigator.vibrate([200, 100, 200]);
      lastVibrationTime = now;
      vibrationTriggered = true;
    } catch {
      vibrationTriggered = false;
    }
  }

  lastAlertId = id;

  const result = {
    triggered: true,
    vibrationSupported,
    vibrationTriggered,
    alertData,
    id,
    timestamp: now,
    reason: withinCooldown ? 'cooldown' : (vibrationSupported ? 'fired' : 'unsupported')
  };

  emitAlert(result);
  return result;
}

export function supportsVibration() {
  return 'vibrate' in navigator;
}

export function resetVibrationCooldown() {
  lastVibrationTime = 0;
  lastAlertId = null;
}

export function simulateSevereAlert() {
  return triggerSevereAlert({
    level: 'severe',
    condition: 'Thunderstorm (simulated)',
    segment: 'Test Segment',
    summary: 'This is a test alert. No real severe weather detected.',
    isTest: true
  });
}
