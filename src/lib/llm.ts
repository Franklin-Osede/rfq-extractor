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
 * Returns the parsed JSON output, validated only against the schema's shape
 * at the provider level — caller may want to zod-parse for extra safety.
 */
export async function callStructured<T>(
  opts: StructuredCallOptions,
): Promise<T> {
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

async function callAnthropic<T>(opts: Required<StructuredCallOptions>): Promise<T> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929', // Sonnet 4.5; pin Sonnet 4.6 once it's GA.
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

  const toolUse = response.content.find((c) => c.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Anthropic did not return a tool_use block');
  }
  return toolUse.input as T;
}

// ─── OpenAI implementation (response_format json_schema) ─────────────────────

async function callOpenAI<T>(opts: Required<StructuredCallOptions>): Promise<T> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
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

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty response');

  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error('OpenAI returned non-JSON content despite json_schema mode');
  }
}
