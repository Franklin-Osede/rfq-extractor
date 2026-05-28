// Smoke test: confirm the LLM layer picks up the configured provider and
// returns a structured response. Reads the API key from .env.local.
//
// Run with:  npx tsx scripts/test-llm.mjs

import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

const { callStructured, detectProvider } = await import('../src/lib/llm.ts');

console.log(`Provider detected: ${detectProvider() ?? 'NONE'}`);
if (!detectProvider()) {
  console.error('No provider configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env.local.');
  process.exit(1);
}

const { output, usage } = await callStructured({
  system: 'You are a smoke-test bot. Always return the same fixed JSON shape.',
  user: 'Reply with greeting="hello" and confidence=0.99.',
  schemaName: 'smoke_test_output',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['greeting', 'confidence'],
    properties: {
      greeting: { type: 'string' },
      confidence: { type: 'number' },
    },
  },
  temperature: 0,
  maxTokens: 100,
});

console.log('Response:', JSON.stringify(output, null, 2));
console.log('Usage:', JSON.stringify(usage, null, 2));

if (typeof output.greeting !== 'string' || typeof output.confidence !== 'number') {
  console.error('\n❌ Output shape unexpected.');
  process.exit(1);
}
if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.latencyMs !== 'number') {
  console.error('\n❌ Usage telemetry missing or malformed.');
  process.exit(1);
}
console.log('\n✅ PASS — LLM layer round-trips a structured call with usage telemetry.');
