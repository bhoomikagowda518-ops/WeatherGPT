const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

export async function getWeatherForPoint(lat, lng) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_direction_10m',
      'visibility'
    ].join(','),
    hourly: [
      'temperature_2m',
      'precipitation_probability',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'visibility'
    ].join(','),
    forecast_days: '2',
    timezone: 'auto'
  });

  try {
    const res = await fetch(`${OPEN_METEO_URL}?${params}`);
    if (!res.ok) {
      if (res.status === 429) {
        return { error: 'Weather service is busy. Please try again.' };
      }
      return { error: 'Weather data temporarily unavailable.' };
    }

    const data = await res.json();
    if (!data || data.error) {
      return { error: 'No weather data available for this location.' };
    }

    return parseWeather(data);
  } catch (err) {
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      return { error: 'Network error. Check your internet connection.' };
    }
    return { error: 'Failed to fetch weather data.' };
  }
}

export async function getWeatherForRoute(checkpoints) {
  const results = [];
  for (const cp of checkpoints) {
    const weather = await getWeatherForPoint(cp.lat, cp.lng);
    results.push({
      ...cp,
      weather
    });
    if (checkpoints.length > 2) {
      await delay(150);
    }
  }
  return results;
}

export async function getWeatherAlongRoute(geometry, totalDuration, numSamples = 5) {
  const points = sampleRoutePoints(geometry, numSamples);
  const results = [];

  for (const point of points) {
    const weather = await getWeatherForPoint(point.lat, point.lng);
    results.push({
      ...point,
      weather
    });
    if (points.length > 2) {
      await delay(150);
    }
  }

  return results;
}

export async function getWeatherForPlaces(places, options = {}) {
  const results = [];
  const departure = options.departureTime ? new Date(options.departureTime) : new Date();
  const totalDuration = options.totalDuration || 0;

  for (let i = 0; i < places.length; i++) {
    const place = places[i];
    const arrivalMs = departure.getTime() + (place.fraction || 0) * totalDuration * 1000;
    const weather = await getWeatherForPoint(place.lat, place.lng);
    const resultWeather = weather && !weather.error
      ? applyArrivalForecast(weather, new Date(arrivalMs))
      : weather;
    results.push({ ...place, weather: resultWeather });
    await delay(150);
  }
  return results;
}

// Select the hourly forecast that matches the traveller's expected arrival time
// at this checkpoint. Weather should never be copied blindly from "current".
const FORECAST_TOLERANCE_MS = 3.5 * 3600000;

export function applyArrivalForecast(weather, arrivalTime) {
  const hourly = weather.hourly || [];
  if (hourly.length === 0) {
    return { ...weather, forecastAtArrival: true };
  }

  let best = null;
  let bestDiff = Infinity;
  for (const h of hourly) {
    const t = new Date(h.time).getTime();
    const diff = Math.abs(t - arrivalTime.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = h;
    }
  }

  if (!best || bestDiff > FORECAST_TOLERANCE_MS) {
    return { ...weather, forecastAtArrival: false, forecastUnavailable: true };
  }

  const code = best.weatherCode != null ? best.weatherCode : weather.weatherCode;
  return {
    ...weather,
    temperature: best.temperature != null ? best.temperature : weather.temperature,
    precipitation: best.precipitation != null ? best.precipitation : weather.precipitation,
    weatherCode: code,
    windSpeed: best.windSpeed != null ? best.windSpeed : weather.windSpeed,
    visibility: best.visibility != null ? best.visibility : weather.visibility,
    hourly: [best],
    condition: getConditionFromCode(code),
    conditionIcon: getIconFromCode(code),
    arrivalTime: best.time,
    forecastAtArrival: true
  };
}

function sampleRoutePoints(geometry, numSamples) {
  if (!geometry || !geometry.coordinates || geometry.coordinates.length < 2) {
    return [];
  }

  const coords = geometry.coordinates;
  const total = coords.length;
  const points = [];

  for (let i = 0; i <= numSamples; i++) {
    const fraction = i / numSamples;
    const idx = Math.min(Math.round(fraction * (total - 1)), total - 1);
    points.push({
      lng: coords[idx][0],
      lat: coords[idx][1],
      fraction
    });
  }

  return points;
}

function parseWeather(data) {
  const current = data.current || {};
  const hourly = data.hourly || {};

  const weatherCode = current.weather_code ?? null;
  const temperature = current.temperature_2m ?? null;
  const humidity = current.relative_humidity_2m ?? null;
  const precipitation = current.precipitation ?? null;
  const windSpeed = current.wind_speed_10m ?? null;
  const windDirection = current.wind_direction_10m ?? null;
  const visibility = current.visibility ?? null;

  const hourlyData = [];
  if (hourly.time) {
    const now = new Date();
    for (let i = 0; i < hourly.time.length; i++) {
      const t = new Date(hourly.time[i]);
      if (t >= new Date(now.getTime() - 3600000)) {
        hourlyData.push({
          time: hourly.time[i],
          temperature: hourly.temperature_2m?.[i] ?? null,
          precipitationProbability: hourly.precipitation_probability?.[i] ?? null,
          precipitation: hourly.precipitation?.[i] ?? null,
          weatherCode: hourly.weather_code?.[i] ?? null,
          windSpeed: hourly.wind_speed_10m?.[i] ?? null,
          visibility: hourly.visibility?.[i] ?? null
        });
      }
    }
  }

  return {
    temperature,
    humidity,
    precipitation,
    weatherCode,
    windSpeed,
    windDirection,
    visibility,
    condition: getConditionFromCode(weatherCode),
    conditionIcon: getIconFromCode(weatherCode),
    hourly: hourlyData,
    raw: data
  };
}

export function getConditionFromCode(code) {
  if (code == null) return 'Unknown';
  const conditions = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snowfall',
    73: 'Moderate snowfall',
    75: 'Heavy snowfall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Thunderstorm with heavy hail'
  };
  return conditions[code] || 'Unknown';
}

export function getIconFromCode(code) {
  if (code == null) return '';
  if (code === 0) return '☀️';
  if (code <= 2) return '⛅';
  if (code === 3) return '☁️';
  if (code >= 45 && code <= 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌧️';
  if (code >= 85 && code <= 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '🌤️';
}

function getWeatherSeverity(temperature, precipitation, precipitationProb, windSpeed, visibility, weatherCode) {
  let score = 0;

  if (weatherCode != null) {
    if (weatherCode >= 95) score += 40;
    else if (weatherCode >= 65 && weatherCode <= 67) score += 30;
    else if (weatherCode >= 61 && weatherCode <= 63) score += 15;
    else if (weatherCode >= 80 && weatherCode <= 82) score += 20;
    else if (weatherCode >= 51 && weatherCode <= 57) score += 10;
  }

  if (precipitation != null && precipitation > 10) score += 20;
  else if (precipitation != null && precipitation > 5) score += 10;

  if (precipitationProb != null && precipitationProb > 80) score += 15;
  else if (precipitationProb != null && precipitationProb > 50) score += 5;

  if (windSpeed != null) {
    if (windSpeed > 60) score += 30;
    else if (windSpeed > 40) score += 20;
    else if (windSpeed > 25) score += 10;
  }

  if (visibility != null) {
    if (visibility < 500) score += 30;
    else if (visibility < 1000) score += 20;
    else if (visibility < 2000) score += 10;
  }

  if (temperature != null) {
    if (temperature > 42 || temperature < -10) score += 20;
  }

  return score;
}

export { getWeatherSeverity };

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
