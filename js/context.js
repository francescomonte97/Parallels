function weatherCodeToItalian(code) {
  const map = {
    0: 'cielo sereno',
    1: 'prevalentemente sereno',
    2: 'parzialmente nuvoloso',
    3: 'coperto',
    45: 'nebbia',
    48: 'nebbia intensa',
    51: 'pioviggine leggera',
    53: 'pioviggine moderata',
    55: 'pioviggine intensa',
    61: 'pioggia leggera',
    63: 'pioggia moderata',
    65: 'pioggia intensa',
    80: 'rovesci leggeri',
    81: 'rovesci moderati',
    82: 'rovesci violenti',
    95: 'temporale',
    99: 'temporale con grandine intensa'
  };
  return map[code] || 'condizioni variabili';
}

export function getDateTimeContext() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome';

  const dateFormatter = new Intl.DateTimeFormat('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone
  });

  const timeFormatter = new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone
  });

  const partsFormatter = new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: timezone
  });

  const parts = partsFormatter.formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);

  let partOfDay = 'notte';
  if (hour >= 5 && hour < 12) partOfDay = 'mattina';
  else if (hour >= 12 && hour < 18) partOfDay = 'pomeriggio';
  else if (hour >= 18 && hour < 23) partOfDay = 'sera';

  return {
    date: dateFormatter.format(now),
    time: timeFormatter.format(now),
    hour,
    minute,
    partOfDay,
    timezone,
    iso: now.toISOString()
  };
}

function getCurrentPositionSafe() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      position => resolve(position),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 1000 * 60 * 15 }
    );
  });
}

async function getWeatherContext() {
  try {
    const position = await getCurrentPositionSafe();
    if (!position) return null;

    const lat = position.coords.latitude;
    const lon = position.coords.longitude;

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
      `&timezone=auto&forecast_days=1`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);

    const data = await response.json();

    return {
      temperature: data?.current?.temperature_2m ?? null,
      apparentTemperature: data?.current?.apparent_temperature ?? null,
      weatherCode: data?.current?.weather_code ?? null,
      weatherLabel: weatherCodeToItalian(data?.current?.weather_code),
      windSpeed: data?.current?.wind_speed_10m ?? null
    };
  } catch {
    return null;
  }
}

function buildEnvironmentalMood({ dateTime, weather }) {
  const lines = [];

  if (dateTime?.date) lines.push(`data attuale: ${dateTime.date}`);

  if (typeof dateTime?.hour === 'number' && typeof dateTime?.minute === 'number') {
    lines.push(
      `ora numerica affidabile: ${String(dateTime.hour).padStart(2, '0')}:${String(dateTime.minute).padStart(2, '0')}`
    );
  }

  if (dateTime?.timezone) lines.push(`fuso orario: ${dateTime.timezone}`);
  if (dateTime?.partOfDay) lines.push(`momento della giornata: ${dateTime.partOfDay}`);
  if (weather?.weatherLabel) lines.push(`condizione esterna: ${weather.weatherLabel}`);
  if (typeof weather?.temperature === 'number') lines.push(`temperatura esterna: ${weather.temperature}°C`);
  if (typeof weather?.apparentTemperature === 'number') lines.push(`temperatura percepita: ${weather.apparentTemperature}°C`);
  if (typeof weather?.windSpeed === 'number') lines.push(`vento: ${weather.windSpeed} km/h`);

  return lines.join('\n');
}

export async function buildEnvironmentalContext() {
  const dateTime = getDateTimeContext();
  const weather = await getWeatherContext();

  return {
    dateTime,
    weather,
    moodText: buildEnvironmentalMood({ dateTime, weather })
  };
}