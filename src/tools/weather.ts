// Weather Tool (plan.md §2.4; spec.md US-08).
//
// Live `wttr.in/{location}?format=j1` fetch with a 60-second cache. Every
// cache entry carries `fetched_at_iso` so the constitution's "no reused-
// as-fresh data" rule is enforceable by inspection: a consumer that
// presents the value as fresh must check the timestamp.
//
// Failure modes (returned as structured errors, never thrown):
//   - timeout / network error → {error: "weather_service_unavailable"}
//   - non-2xx response          → {error: "weather_service_unavailable"}
//   - parse failure             → {error: "weather_parse_failed"}
//
// The agent's hallucination guard (US-06) says: surface the error
// honestly, do not guess.

import { z } from 'zod';

import { log } from '../logger.js';
import type { ToolDefinition } from './types.js';

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 4_000;

interface CacheEntry {
  readonly value: WeatherResult;
  readonly fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

const argsSchema = z.object({
  location: z.string().min(1).max(120).describe(
    'A city, postal code, airport code, or other location string accepted by wttr.in.',
  ),
});

export interface WeatherResult {
  readonly location: string;
  readonly condition: string;
  readonly temp_f: number;
  readonly feels_like_f: number;
  readonly humidity: number;
  readonly wind_mph: number;
  readonly fetched_at_iso: string;
  readonly source: 'wttr.in';
}

interface WttrCurrentCondition {
  readonly temp_F?: string;
  readonly FeelsLikeF?: string;
  readonly weatherDesc?: readonly { readonly value?: string }[];
  readonly humidity?: string;
  readonly windspeedMiles?: string;
}
interface WttrResponse {
  readonly current_condition?: readonly WttrCurrentCondition[];
}

export const weatherTool: ToolDefinition<{ location: string }> = {
  name: 'wttr_get',
  description: 'Get the current weather for a location. The location is a city name, postal code, or airport code accepted by wttr.in.',
  userFacingSummary: 'Tell you the current weather anywhere wttr.in covers (city, ZIP, airport code).',
  slowFiller: 'Looking up the weather.',
  schema: argsSchema,
  handler: async (args, ctx) => {
    const baseUrl = ctx.env.wttrBaseUrl;
    const key = args.location.trim().toLowerCase();
    const now = Date.now();

    const cached = cache.get(key);
    if (cached !== undefined && now - cached.fetchedAt < CACHE_TTL_MS) {
      // Cache hit — but consumers MUST treat fetched_at_iso as truth.
      log.info({ event: 'weather.cache_hit', location: key, ageMs: now - cached.fetchedAt });
      return cached.value;
    }

    const url = `${baseUrl}/${encodeURIComponent(args.location)}?format=j1`;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'jarvis/0.1 (+wttr live)' },
        signal: controller.signal,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.warn({ event: 'weather.fetch_failed', location: key, message });
      return { error: 'weather_service_unavailable', location: args.location, message } as const;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      log.warn({ event: 'weather.bad_status', location: key, status: res.status });
      return {
        error: 'weather_service_unavailable',
        location: args.location,
        status: res.status,
      } as const;
    }

    let parsed: WttrResponse;
    try {
      parsed = (await res.json()) as WttrResponse;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.warn({ event: 'weather.json_parse_failed', location: key, message });
      return { error: 'weather_parse_failed', location: args.location, message } as const;
    }

    const current = parsed.current_condition?.[0];
    if (current === undefined) {
      return { error: 'weather_parse_failed', location: args.location, message: 'current_condition empty' } as const;
    }

    const result: WeatherResult = {
      location: args.location,
      condition: current.weatherDesc?.[0]?.value ?? 'Unknown',
      temp_f: numericOr(current.temp_F, NaN),
      feels_like_f: numericOr(current.FeelsLikeF, NaN),
      humidity: numericOr(current.humidity, NaN),
      wind_mph: numericOr(current.windspeedMiles, NaN),
      fetched_at_iso: new Date().toISOString(),
      source: 'wttr.in',
    };

    cache.set(key, { value: result, fetchedAt: now });
    return result;
  },
};

function numericOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

// Exposed for tests. Clears the in-memory cache.
export function _resetWeatherCacheForTests(): void {
  cache.clear();
}
