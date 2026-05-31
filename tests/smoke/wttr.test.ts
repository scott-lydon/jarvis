// Smoke test against the LIVE wttr.in endpoint (no mocks).
// CLAUDE.md HARD RULE: no mocks in production paths. This is the contract
// test that proves wttr.in still returns the JSON shape we depend on.
// Runs in the smoke-tests script: `npm run smoke:wttr`.

import { describe, expect, it } from 'vitest';

const WTTR_BASE_URL = process.env.WTTR_BASE_URL ?? 'https://wttr.in';
const LOCATION = 'Austin';

// wttr.in's j1 schema. We assert just enough to know the response is the
// schema we coded against. Full type defined in src/tools/weather.ts when
// the tool lands; this test is the schema canary.
interface WttrCurrentCondition {
  readonly temp_F: string;
  readonly FeelsLikeF: string;
  readonly weatherDesc: readonly { readonly value: string }[];
  readonly humidity: string;
  readonly windspeedMiles: string;
}
interface WttrResponse {
  readonly current_condition: readonly WttrCurrentCondition[];
}

describe('smoke: wttr.in current weather', () => {
  it(`responds with current_condition[0].temp_F as a numeric string for ${LOCATION}`, async () => {
    const url = `${WTTR_BASE_URL}/${encodeURIComponent(LOCATION)}?format=j1`;
    const startedAt = Date.now();
    const res = await fetch(url, {
      // wttr.in defaults to text/plain rendering for browser UAs; the
      // header below is unnecessary for ?format=j1 but harmless.
      headers: { 'Accept': 'application/json' },
    });
    expect(res.ok, `expected 2xx from ${url}, got ${String(res.status)}`).toBe(true);

    const json = (await res.json()) as WttrResponse;
    expect(Array.isArray(json.current_condition), 'current_condition must be an array').toBe(true);
    expect(json.current_condition.length, 'current_condition must not be empty').toBeGreaterThan(0);

    const current = json.current_condition[0];
    if (current === undefined) throw new Error('current_condition[0] is unexpectedly undefined after length check');
    expect(typeof current.temp_F, 'temp_F is a string per wttr.in j1 schema').toBe('string');
    expect(Number.isFinite(Number.parseInt(current.temp_F, 10)), 'temp_F parses as a finite integer').toBe(true);
    expect(current.weatherDesc[0]?.value).toBeTypeOf('string');

    const elapsedMs = Date.now() - startedAt;
    // Latency budget: the slowest acceptable wttr.in response is 3000ms;
    // if it's slower than that, our 1.5s first-audio budget (US-01) is at risk.
    expect(elapsedMs, `wttr.in latency was ${String(elapsedMs)}ms (budget 3000ms)`).toBeLessThan(3000);
  });
});
