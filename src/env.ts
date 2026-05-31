// Environment variable loader. Reads .env via dotenv on import.
// All env access in the codebase MUST go through this module so the
// shape stays in one place and missing-required errors surface early.

import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Required environment variable ${name} is not set. ` +
      `Copy .env.example to .env and fill in a real value, or export ` +
      `${name} in your shell before starting the server.`,
    );
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export interface JarvisEnv {
  readonly openaiApiKey: string;
  readonly githubToken: string | null;
  readonly wttrBaseUrl: string;
  readonly dbPath: string;
  readonly port: number;
  readonly realtimeModel: string;
  readonly realtimeVoice: string;
  readonly host: string;
  // Optional override of the upstream Realtime WebSocket URL. Production
  // leaves this undefined; integration tests set it to a local fake
  // upstream so they can measure proxy behavior without calling OpenAI.
  readonly realtimeUrlOverride: string | null;
}

export function loadEnv(): JarvisEnv {
  const port = Number.parseInt(optionalEnv('PORT', '3000'), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid TCP port; got "${process.env.PORT ?? ''}".`);
  }
  return {
    openaiApiKey: requireEnv('OPENAI_API_KEY'),
    githubToken: process.env.GITHUB_TOKEN ?? null,
    wttrBaseUrl: optionalEnv('WTTR_BASE_URL', 'https://wttr.in'),
    dbPath: optionalEnv('JARVIS_DB_PATH', './data/jarvis.db'),
    port,
    realtimeModel: optionalEnv('JARVIS_REALTIME_MODEL', 'gpt-realtime'),
    realtimeVoice: optionalEnv('JARVIS_REALTIME_VOICE', 'marin'),
    host: optionalEnv('JARVIS_HOST', '0.0.0.0'),
    realtimeUrlOverride: process.env.JARVIS_REALTIME_URL_OVERRIDE ?? null,
  };
}
