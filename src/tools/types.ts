// Shared types for the Tool Dispatcher (plan.md §2.3). Every tool is a
// {name, description, schema, handler} record. Description is what the
// model sees AND what the user hears when they ask "what can you do?",
// so it is written for both audiences.

import type { z } from 'zod';
import type Database from 'better-sqlite3';

import type { JarvisEnv } from '../env.js';

export interface ToolContext {
  readonly userId: string;
  readonly env: JarvisEnv;
  readonly db: Database.Database | null;
}

export interface ToolDefinition<Args> {
  readonly name: string;
  // The model-facing description. Also the user-facing "what can you do?"
  // line — write it so it reads cleanly aloud.
  readonly description: string;
  // Human-readable capability summary (what the agent says it can do).
  // If omitted, falls back to `description`.
  readonly userFacingSummary?: string;
  // zod schema for arguments.
  readonly schema: z.ZodType<Args>;
  // Async handler. Throws → wrapped as a structured error; return value is
  // sent back to the model as a JSON-stringified result.
  readonly handler: (args: Args, ctx: ToolContext) => Promise<unknown>;
  // Tools whose typical call time exceeds 1000ms get a filler audio cue
  // emitted by the dispatcher (US-02). Filler text is read aloud.
  readonly slowFiller?: string;
  // Optional availability check. Return null when available, or a reason
  // string when not (e.g. "GITHUB_TOKEN is not set"). The capability list
  // omits unavailable tools and the agent speaks the reason if asked.
  readonly available?: (env: JarvisEnv) => string | null;
}

export interface RegisteredTool {
  readonly def: ToolDefinition<unknown>;
}

export type AnyToolDefinition = ToolDefinition<unknown>;
