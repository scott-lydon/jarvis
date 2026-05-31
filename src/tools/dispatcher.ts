// Tool Dispatcher (plan.md §2.3).
//
// Holds the live registry of tools. Exposes:
//   - register(def) — add a tool to the registry.
//   - list() — every registered tool, regardless of env availability.
//   - capabilities(env) — only tools that are available right now, with
//     the reasons for any disabled ones (US-05 self-awareness).
//   - openaiToolsSpec(env) — the `tools[]` array passed to OpenAI
//     Realtime via session.update.
//   - dispatch(name, rawArgs, ctx) — validate args via the tool's zod
//     schema, run the handler, wrap throws as structured tool errors so
//     the agent never sees an exception trace.
//
// IMPORTANT: the dispatcher is the single seam between OpenAI function
// calls and our business code. All zod-validation, error-wrapping, and
// timing instrumentation live here so each tool's handler stays focused
// on the actual side effect.

import type { ZodError } from 'zod';

import type { JarvisEnv } from '../env.js';
import { log } from '../logger.js';
import type { AnyToolDefinition, ToolContext, ToolDefinition } from './types.js';

export interface ToolError {
  readonly error: string;
  readonly tool: string;
  readonly message?: string;
  readonly issues?: readonly unknown[];
  readonly cause?: unknown;
}

export interface ToolDispatchResult {
  readonly ok: boolean;
  readonly tool: string;
  readonly durationMs: number;
  readonly value: unknown;
}

export interface CapabilityEntry {
  readonly name: string;
  readonly summary: string;
  readonly available: boolean;
  readonly disabledReason: string | null;
}

export class ToolDispatcher {
  readonly #tools = new Map<string, AnyToolDefinition>();

  register<Args>(def: ToolDefinition<Args>): void {
    if (this.#tools.has(def.name)) {
      throw new Error(`Tool ${def.name} is already registered. Tool names must be unique.`);
    }
    this.#tools.set(def.name, def as AnyToolDefinition);
  }

  list(): readonly AnyToolDefinition[] {
    return [...this.#tools.values()];
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /**
   * Capability list as it stands in the current environment. Used to
   * render the system prompt's "what you can do" block (US-05) and to
   * answer the user's "what can you do?" question with the LIVE state.
   */
  capabilities(env: JarvisEnv): readonly CapabilityEntry[] {
    return this.list().map((def) => {
      const disabledReason = def.available?.(env) ?? null;
      return {
        name: def.name,
        summary: def.userFacingSummary ?? def.description,
        available: disabledReason === null,
        disabledReason,
      };
    });
  }

  /**
   * Build the OpenAI Realtime `session.tools[]` array. Filters out
   * tools that are unavailable so the model can't call them.
   */
  openaiToolsSpec(env: JarvisEnv): readonly unknown[] {
    return this.list()
      .filter((def) => (def.available?.(env) ?? null) === null)
      .map((def) => {
        // GA Realtime tools shape: {type:"function", name, description, parameters: <JSON Schema>}
        const parameters = zodToJsonSchemaSafe(def.schema);
        return {
          type: 'function',
          name: def.name,
          description: def.description,
          parameters,
        };
      });
  }

  /**
   * Look up `name`, parse `rawArgs`, run the handler.
   *
   * Returns a discriminated result so the proxy can decide whether to
   * forward the result, a graceful error, or both. NEVER throws on a
   * handler failure — the failure is wrapped as a structured ToolError
   * so the model can speak it honestly (the "no fabrication" rule).
   */
  async dispatch(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<ToolDispatchResult> {
    const startedAt = Date.now();
    const def = this.#tools.get(name);
    if (def === undefined) {
      log.warn({ event: 'dispatcher.unknown_tool', tool: name });
      return {
        ok: false,
        tool: name,
        durationMs: Date.now() - startedAt,
        value: { error: 'tool_not_found', tool: name } satisfies ToolError,
      };
    }

    const disabledReason = def.available?.(ctx.env) ?? null;
    if (disabledReason !== null) {
      return {
        ok: false,
        tool: name,
        durationMs: Date.now() - startedAt,
        value: {
          error: 'tool_disabled',
          tool: name,
          message: disabledReason,
        } satisfies ToolError,
      };
    }

    const parsed = def.schema.safeParse(rawArgs);
    if (!parsed.success) {
      const zErr: ZodError = parsed.error;
      log.warn({
        event: 'dispatcher.invalid_args',
        tool: name,
        issues: zErr.issues,
      });
      return {
        ok: false,
        tool: name,
        durationMs: Date.now() - startedAt,
        value: {
          error: 'tool_args_invalid',
          tool: name,
          issues: zErr.issues,
        } satisfies ToolError,
      };
    }

    try {
      const value = await def.handler(parsed.data, ctx);
      return {
        ok: true,
        tool: name,
        durationMs: Date.now() - startedAt,
        value,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error({
        event: 'dispatcher.handler_threw',
        tool: name,
        message,
        cause: cause instanceof Error ? { name: cause.name, stack: cause.stack } : undefined,
      });
      return {
        ok: false,
        tool: name,
        durationMs: Date.now() - startedAt,
        value: {
          error: 'tool_failed',
          tool: name,
          message,
        } satisfies ToolError,
      };
    }
  }
}

// --- minimal zod → JSON Schema --------------------------------------------
// The full zod-to-json-schema package is heavy. We only need the shapes
// our tool args use: objects with string/number/boolean/enum/optional
// properties. If a future tool needs unions or refinements, the function
// below should be extended deliberately (and tested), not silently widened.

interface AnyZodInternals {
  readonly _def: {
    readonly typeName?: string;
    readonly innerType?: { readonly _def: AnyZodInternals['_def'] };
    readonly shape?: () => Record<string, { readonly _def: AnyZodInternals['_def'] }>;
    readonly values?: readonly string[];
    readonly value?: string | number | boolean;
    readonly description?: string;
    readonly defaultValue?: () => unknown;
  };
}

function zodToJsonSchemaSafe(schema: unknown): unknown {
  const s = schema as AnyZodInternals;
  return zodNode(s);
}

function zodNode(node: AnyZodInternals): unknown {
  const td = node._def.typeName;
  const description = node._def.description;
  const withDesc = (obj: Record<string, unknown>): Record<string, unknown> =>
    description === undefined ? obj : { ...obj, description };

  switch (td) {
    case 'ZodString':   return withDesc({ type: 'string' });
    case 'ZodNumber':   return withDesc({ type: 'number' });
    case 'ZodBoolean':  return withDesc({ type: 'boolean' });
    case 'ZodEnum':     return withDesc({ type: 'string', enum: node._def.values ?? [] });
    case 'ZodLiteral':  return withDesc({ const: node._def.value });
    case 'ZodOptional': {
      const inner = node._def.innerType;
      if (inner === undefined) return withDesc({});
      return zodNode({ _def: inner._def });
    }
    case 'ZodDefault': {
      const inner = node._def.innerType;
      const base = inner === undefined ? {} : (zodNode({ _def: inner._def }) as Record<string, unknown>);
      try {
        const def = node._def.defaultValue?.();
        return withDesc({ ...base, default: def });
      } catch {
        return withDesc(base);
      }
    }
    case 'ZodObject': {
      const shape = node._def.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const key of Object.keys(shape)) {
        const child = shape[key];
        if (child === undefined) continue;
        properties[key] = zodNode({ _def: child._def });
        if (child._def.typeName !== 'ZodOptional' && child._def.typeName !== 'ZodDefault') {
          required.push(key);
        }
      }
      return withDesc({
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      });
    }
    default:
      // Unknown node — emit a permissive schema so the model can still
      // call the tool, and surface a warning so we know to extend this.
      log.warn({ event: 'dispatcher.zod_to_json_unknown_node', typeName: td ?? 'unknown' });
      return withDesc({});
  }
}
