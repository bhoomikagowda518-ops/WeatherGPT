import { getWeatherSeverity } from './weather.js';

export function calculateRouteRisk(routeWeatherData) {
  if (!routeWeatherData || routeWeatherData.length === 0) {
    return {
      level: 'unknown',
      score: 0,
      segments: [],
      summary: 'Weather data unavailable for this route.',
      details: []
    };
  }

  let totalScore = 0;
  let validPoints = 0;
  const segments = [];
  const details = [];

  for (const point of routeWeatherData) {
    const w = point.weather;
    if (!w || w.error) {
      segments.push({
        fraction: point.fraction,
        lat: point.lat,
        lng: point.lng,
        level: 'unknown',
        description: 'Weather data unavailable for this segment.'
      });
      details.push({
        fraction: point.fraction,
        lat: point.lat,
        lng: point.lng,
        condition: 'Weather data unavailable',
        evidence: []
      });
      continue;
    }

    const severity = getWeatherSeverity(
      w.temperature,
      w.precipitation,
      w.hourly?.[0]?.precipitationProbability,
      w.windSpeed,
      w.visibility,
      w.weatherCode
    );

    totalScore += severity;
    validPoints++;

    const evidence = [];
    let segLevel = 'low';

    if (w.weatherCode != null && w.weatherCode >= 95) {
      segLevel = 'severe';
      evidence.push(`Thunderstorm detected (weather code: ${w.weatherCode})`);
    } else if (w.weatherCode != null && w.weatherCode >= 65 && w.weatherCode <= 67) {
      segLevel = 'high';
      evidence.push(`Heavy precipitation (${w.condition})`);
    } else if (w.windSpeed != null && w.windSpeed > 60) {
      segLevel = 'high';
      evidence.push(`Dangerous wind speed: ${Math.round(w.windSpeed)} km/h`);
    } else if (w.visibility != null && w.visibility < 500) {
      segLevel = 'high';
      evidence.push(`Very poor visibility: ${Math.round(w.visibility)}m`);
    } else if (severity >= 30) {
      segLevel = 'high';
      if (w.precipitation != null && w.precipitation > 5) {
        evidence.push(`Heavy rainfall: ${w.precipitation.toFixed(1)} mm`);
      }
      if (w.windSpeed != null && w.windSpeed > 40) {
        evidence.push(`Strong wind: ${Math.round(w.windSpeed)} km/h`);
      }
    } else if (severity >= 15) {
      segLevel = 'moderate';
      if (w.precipitation != null && w.precipitation > 1) {
        evidence.push(`Rainfall: ${w.precipitation.toFixed(1)} mm`);
      }
      if (w.windSpeed != null && w.windSpeed > 25) {
        evidence.push(`Moderate wind: ${Math.round(w.windSpeed)} km/h`);
      }
      if (w.visibility != null && w.visibility < 2000) {
        evidence.push(`Reduced visibility: ${Math.round(w.visibility)}m`);
      }
    } else {
      if (w.condition) evidence.push(`Weather: ${w.condition}`);
    }

    segments.push({
      fraction: point.fraction,
      lat: point.lat,
      lng: point.lng,
      level: segLevel,
      description: generateSegmentDescription(w, segLevel),
      weather: w
    });

    details.push({
      fraction: point.fraction,
      lat: point.lat,
      lng: point.lng,
      condition: w.condition || 'Unknown',
      conditionIcon: w.conditionIcon || '',
      temperature: w.temperature,
      precipitation: w.precipitation,
      precipitationProbability: w.hourly?.[0]?.precipitationProbability,
      windSpeed: w.windSpeed,
      visibility: w.visibility,
      severity,
      evidence,
      level: segLevel
    });
  }

  const avgScore = validPoints > 0 ? totalScore / validPoints : 0;
  const overallLevel = determineOverallRisk(avgScore, segments);

  return {
    level: overallLevel,
    score: avgScore,
    segments,
    details,
    summary: generateRiskSummary(overallLevel, details),
    recommendation: generateRecommendation(overallLevel, details)
  };
}

function determineOverallRisk(avgScore, segments) {
  const hasSevere = segments.some(s => s.level === 'severe');
  if (hasSevere) return 'severe';
  if (avgScore >= 30) return 'high';
  if (avgScore >= 15) return 'moderate';
  return 'low';
}

function generateSegmentDescription(weather, level) {
  const parts = [];
  if (weather.condition) parts.push(weather.condition);

  if (weather.precipitation != null && weather.precipitation > 0) {
    parts.push(`Precipitation: ${weather.precipitation.toFixed(1)} mm`);
  }
  if (weather.windSpeed != null) {
    parts.push(`Wind: ${Math.round(weather.windSpeed)} km/h`);
  }
  if (weather.visibility != null && weather.visibility < 5000) {
    parts.push(`Visibility: ${(weather.visibility / 1000).toFixed(1)} km`);
  }
  if (weather.temperature != null) {
    parts.push(`Temperature: ${Math.round(weather.temperature)}°C`);
  }

  return parts.join(' · ') || 'Weather data available';
}

function generateRiskSummary(level, details) {
  const severityCount = { low: 0, moderate: 0, high: 0, severe: 0, unknown: 0 };
  details.forEach(d => severityCount[d.level || 'unknown']++);

  switch (level) {
    case 'severe':
      return `Severe weather conditions detected along this route. Exercise extreme caution.`;
    case 'high':
      return `Challenging weather conditions on parts of this route. Plan accordingly.`;
    case 'moderate':
      return `Some weather conditions may affect this route. Stay alert.`;
    case 'low':
      return `Weather conditions are generally favorable for this journey.`;
    default:
      return `Weather information is limited for this route.`;
  }
}

function generateRecommendation(level, details) {
  const severePoints = details.filter(d => d.level === 'severe');
  const highPoints = details.filter(d => d.level === 'high');

  if (severePoints.length > 0) {
    const conditions = severePoints.map(p => p.condition).filter(Boolean);
    return `Consider delaying your trip. Severe weather (${conditions.join(', ')}) expected along parts of your route.`;
  }

  if (highPoints.length > 0) {
    const conditions = highPoints.map(p => p.condition).filter(Boolean);
    return `Exercise caution. ${conditions.join(', ')} conditions expected along parts of this route.`;
  }

  if (level === 'moderate') {
    return `Route is passable. Some weather variations expected along the way.`;
  }

  return `Good conditions for travel. Weather should not significantly impact your journey.`;
}

export function classifySegmentSeverity(severityScore) {
  if (severityScore >= 40) return 'severe';
  if (severityScore >= 25) return 'high';
  if (severityScore >= 12) return 'moderate';
  return 'low';
}

export function isSevereEnoughForVibration(level) {
  return level === 'high' || level === 'severe';
}
