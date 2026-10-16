// The busy API's answer: a short city forecast. Real data from Open-Meteo (free, no key) for a fixed
// list of cities, refreshed in the background and cached; the request path only reads the cache, so a
// paid response never waits on an upstream. Unknown cities, a cold cache or X429_FORECAST_SOURCE=demo
// fall back to a deterministic demo forecast (labeled as such).
import { createHash } from "node:crypto";

type Hour = { hour: string; tempC: number; rainPct: number; windKph: number; sky: string };
export type Forecast = { city: string; date: string; summary: string; hours: Hour[]; source: string; note?: string };

const CITIES: Record<string, [number, number]> = {
  lisbon: [38.72, -9.14],
  london: [51.51, -0.13],
  paris: [48.86, 2.35],
  berlin: [52.52, 13.41],
  madrid: [40.42, -3.7],
  "new york": [40.71, -74.01],
  "san francisco": [37.77, -122.42],
  chicago: [41.88, -87.63],
  "sao paulo": [-23.55, -46.63],
  tokyo: [35.68, 139.69],
  singapore: [1.35, 103.82],
  sydney: [-33.87, 151.21],
};

const WMO: [number, string][] = [
  [0, "clear"], [1, "mostly clear"], [2, "partly cloudy"], [3, "overcast"], [45, "fog"], [48, "fog"],
  [51, "drizzle"], [53, "drizzle"], [55, "drizzle"], [61, "light rain"], [63, "rain"], [65, "heavy rain"],
  [71, "snow"], [73, "snow"], [75, "heavy snow"], [80, "showers"], [81, "showers"], [82, "heavy showers"],
  [95, "thunderstorm"], [96, "thunderstorm"], [99, "thunderstorm"],
];
const sky = (code: number) => WMO.find(([c]) => c === code)?.[1] ?? "mixed";

function summarize(city: string, date: string, hours: Hour[]): string {
  const temps = hours.map((x) => x.tempC);
  const wettest = hours.reduce((a, b) => (b.rainPct > a.rainPct ? b : a));
  const windiest = hours.reduce((a, b) => (b.windKph > a.windKph ? b : a));
  const rain = wettest.rainPct >= 50 ? `take an umbrella (${wettest.rainPct}% rain at ${wettest.hour})` : `mostly dry (at most ${wettest.rainPct}% rain)`;
  return `${city}, ${date}: ${Math.min(...temps)} to ${Math.max(...temps)} °C, ${rain}, windiest at ${windiest.hour} (${windiest.windKph} km/h).`;
}

export function cityName(raw: unknown): string {
  const city = typeof raw === "string" ? raw.replace(/[^\p{L}\p{N} .,'-]/gu, "").trim().slice(0, 60) : "";
  return city || "Lisbon";
}

/** A deterministic demo forecast: same city and day, same answer. */
export function demoForecast(city: string): Forecast {
  const date = new Date().toISOString().slice(0, 10);
  const h = createHash("sha256").update(`${city.toLowerCase()}|${date}`).digest();
  const conditions = ["clear", "partly cloudy", "overcast", "light rain", "showers", "windy", "fog"];
  const hours = Array.from({ length: 6 }, (_, i) => ({
    hour: `${String(9 + i * 2).padStart(2, "0")}:00`,
    tempC: 8 + (h[i]! % 18),
    rainPct: h[i + 6]! % 100,
    windKph: 4 + (h[i + 12]! % 30),
    sky: conditions[h[i + 18]! % conditions.length]!,
  }));
  return { city, date, summary: summarize(city, date, hours), hours, source: "demo", note: "Demo data, not a real weather service." };
}

export class ForecastService {
  private readonly cache = new Map<string, { at: number; value: Forecast }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly live: boolean;
  private readonly refreshMs: number;

  constructor(source: string, refreshMs = 30 * 60_000) {
    this.live = source !== "demo";
    this.refreshMs = refreshMs;
  }

  start(): void {
    if (!this.live || this.timer) return;
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Cached real data when available (at most two refresh periods old), else the demo forecast. */
  get(rawCity: unknown): Forecast {
    const city = cityName(rawCity);
    const hit = this.live ? this.cache.get(city.toLowerCase()) : undefined;
    if (hit && Date.now() - hit.at < 2 * this.refreshMs) return { ...hit.value, city };
    return demoForecast(city);
  }

  cities(): string[] {
    return Object.keys(CITIES);
  }

  private async refreshAll(): Promise<void> {
    for (const key of Object.keys(CITIES)) {
      await this.refresh(key).catch(() => undefined); // keep the old value; try again next period
    }
  }

  private async refresh(key: string): Promise<void> {
    const [lat, lon] = CITIES[key]!;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code&forecast_days=2&timezone=UTC`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const d = (await res.json()) as { hourly: { time: string[]; temperature_2m: number[]; precipitation_probability: number[]; wind_speed_10m: number[]; weather_code: number[] } };
    const now = new Date().toISOString().slice(0, 13);
    const start = Math.max(0, d.hourly.time.findIndex((t) => t.slice(0, 13) >= now));
    const hours: Hour[] = [];
    for (let i = start; i < d.hourly.time.length && hours.length < 6; i += 2) {
      hours.push({
        hour: `${d.hourly.time[i]!.slice(11, 16)} UTC`,
        tempC: Math.round(d.hourly.temperature_2m[i]!),
        rainPct: Math.round(d.hourly.precipitation_probability[i] ?? 0),
        windKph: Math.round(d.hourly.wind_speed_10m[i]!),
        sky: sky(d.hourly.weather_code[i]!),
      });
    }
    if (hours.length === 0) throw new Error("open-meteo: no hours");
    const date = d.hourly.time[start]!.slice(0, 10);
    const name = key.replace(/\b\w/g, (c) => c.toUpperCase());
    this.cache.set(key, { at: Date.now(), value: { city: name, date, summary: summarize(name, date, hours), hours, source: "open-meteo.com (CC BY 4.0)" } });
  }
}
