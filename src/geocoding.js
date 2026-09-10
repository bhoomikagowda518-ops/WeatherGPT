const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

const HEADERS = {
  'User-Agent': 'WeatherGPT-RouteIntelligence/1.0'
};

export { geocodeLocation, searchCandidates, resolveLocationText } from './locationSearch.js';

function formatReverseName(data) {
  if (!data) return null;

  if (data.address) {
    const a = data.address;
    const name = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.neighbourhood;
    const state = a.state;
    if (name && state) return `${name}, ${state}`;
    if (name) return name;
    if (state) return state;
  }

  if (data.display_name) {
    const parts = data.display_name.split(',');
    if (parts.length >= 2) {
      return parts.slice(0, 2).join(',').trim();
    }
    return parts[0]?.trim() || null;
  }

  return null;
}

export async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return null;

  const params = new URLSearchParams({
    lat: lat.toString(),
    lon: lng.toString(),
    format: 'json',
    zoom: '14',
    addressdetails: '1'
  });

  try {
    const res = await fetch(`${NOMINATIM_REVERSE_URL}?${params}`, { headers: HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    return formatReverseName(data);
  } catch {
    return null;
  }
}