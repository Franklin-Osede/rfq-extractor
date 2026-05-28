/**
 * Provider-agnostic LLM layer.
 *
 * Picks Anthropic Claude Sonnet 4.6 if `ANTHROPIC_API_KEY` is set; otherwise
 * falls back to OpenAI gpt-4o-mini if `OPENAI_API_KEY` is set; otherwise
 * throws `NoLlmProviderConfiguredError`.
 *
 * Both providers expose structured-output APIs (Anthropic tool-use with
 * `input_schema`, OpenAI response_format with `json_schema`). We wrap them
 * behind a single `callStructured<T>()` so the enrichment code in
 * src/lib/enrich.ts is provider-blind.
 *
 * Why this matters for the demo: founders asked "what if you can't use
 * Anthropic in production for some EU compliance reason?" The honest
 * answer is the system already supports OpenAI with one env-var change.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type LlmProvider = 'anthropic' | 'openai';

/** Per-call telemetry surfaced for cost/latency accounting. */
export type LlmUsage = {
  provider: LlmProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type LlmCallResult<T> = {
  output: T;
  usage: LlmUsage;
};

/**
 * USD per 1M tokens for each model we use. Numbers are rough public-list
 * pricing and may drift; they're only used for an estimate surfaced in the
 * UI ("$0.10 estimated cost"), not for billing. Update when providers
 * publish new tiers.
 */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-5-20250929': { in: 3.0, out: 15.0 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
};

export function estimateCostUsd(usage: LlmUsage): number {
  const p = PRICING[usage.model];
  if (!p) return 0;
  return (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000;
}

export class NoLlmProviderConfiguredError extends Error {
  constructor() {
    super(
      'No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.local.',
    );
    this.name = 'NoLlmProviderConfiguredError';
  }
}

export function detectProvider(): LlmProvider | null {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

export type StructuredCallOptions = {
  /** The system / role prompt. */
  system: string;
  /** The user message with the actual task + context. */
  user: string;
  /** JSON Schema (object) describing the expected output shape. */
  schema: Record<string, unknown>;
  /** Short label of the schema (used by both APIs to name the tool/function). */
  schemaName: string;
  /** 0 for deterministic extraction; 0.2-0.4 for rationale generation. */
  temperature?: number;
  /** Hard cap on response tokens. */
  maxTokens?: number;
};

/**
 * Make a structured-output call to whichever provider is configured.
 * Returns the parsed JSON output and per-call telemetry (tokens + latency)
 * so callers can aggregate cost/latency without instrumenting every site.
 */
export async function callStructured<T>(
  opts: StructuredCallOptions,
): Promise<LlmCallResult<T>> {
  const provider = detectProvider();
  if (!provider) throw new NoLlmProviderConfiguredError();

  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxTokens ?? 1024;

  if (provider === 'anthropic') {
    return callAnthropic<T>({ ...opts, temperature, maxTokens });
  }
  return callOpenAI<T>({ ...opts, temperature, maxTokens });
}

// ─── Anthropic implementation (tool-use forced) ──────────────────────────────

async function callAnthropic<T>(
  opts: Required<StructuredCallOptions>,
): Promise<LlmCallResult<T>> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const model = 'claude-sonnet-4-5-20250929'; // Sonnet 4.5; pin Sonnet 4.6 once it's GA.

  const t0 = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    system: opts.system,
    tools: [
      {
        name: opts.schemaName,
        description: `Return the response conforming to the ${opts.schemaName} schema.`,
        input_schema: opts.schema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: opts.schemaName },
    messages: [{ role: 'user', content: opts.user }],
  });
  const latencyMs = Date.now() - t0;

  const toolUse = response.content.find((c) => c.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Anthropic did not return a tool_use block');
  }
  return {
    output: toolUse.input as T,
    usage: {
      provider: 'anthropic',
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs,
    },
  };
}

// ─── OpenAI implementation (response_format json_schema) ─────────────────────

async function callOpenAI<T>(
  opts: Required<StructuredCallOptions>,
): Promise<LlmCallResult<T>> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const model = 'gpt-4o-mini';

  const t0 = Date.now();
  const response = await client.chat.completions.create({
    model,
    temperature: opts.temperature,
    max_completion_tokens: opts.maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: opts.schemaName,
        // OpenAI requires `strict: true` and `additionalProperties: false`
        // at every level. We trust the caller to provide a compliant schema
        // (the enrich layer does).
        strict: true,
        schema: opts.schema,
      },
    },
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
  });
  const latencyMs = Date.now() - t0;

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty response');

  let parsed: T;
  try {
    parsed = JSON.parse(content) as T;
  } catch {
    throw new Error('OpenAI returned non-JSON content despite json_schema mode');
  }
  return {
    output: parsed,
    usage: {
      provider: 'openai',
      model,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs,
    },
  };
}
