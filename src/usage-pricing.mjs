import { fingerprint } from './fingerprint.mjs';

// Bundled reference rates in USD per million tokens (2026-09-15).
// Per-request tier and context adjustments are applied below.
export const STANDARD_PRICES = {
  'gpt-6-astra': { input: 10, cacheRead: 1, cacheCreation: 12.5, output: 50 },
  'gpt-5.6-sol': { input: 4, cacheRead: 0.4, cacheCreation: 5, output: 20 },
  'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, cacheCreation: 0.25, output: 1.2 },
};
export const COST_BASIS = `standard-base-2026-09-15:${fingerprint(JSON.stringify(STANDARD_PRICES))}`;
export const LEDGER_PRICE_BASIS = `${COST_BASIS}:request-272k-fast2-v1`;

/** API-equivalent price per request; unknown speed is a Standard-to-Fast interval. */
export function priceRequest(request) {
  const rate = Object.hasOwn(STANDARD_PRICES, request.model) ? STANDARD_PRICES[request.model] : null;
  if (!rate) return null;
  const usage = request.usage;
  const longContext = usage.input_tokens > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const ordinaryInput = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens;
  const base = ((ordinaryInput * rate.input + usage.cached_input_tokens * rate.cacheRead
    + usage.cache_write_input_tokens * rate.cacheCreation) * inputMultiplier
    + usage.output_tokens * rate.output * outputMultiplier) / 1_000_000;
  const tier = request.tier ?? request.assumedTier;
  if (['priority', 'fast'].includes(tier)) return { minimum: base * 2, maximum: base * 2, unknownSpeed: false, longContext };
  if (tier === 'default') return { minimum: base, maximum: base, unknownSpeed: false, longContext };
  if (['flex', 'batch'].includes(tier)) return { minimum: base / 2, maximum: base / 2, unknownSpeed: false, longContext };
  return { minimum: base, maximum: base * 2, unknownSpeed: true, longContext };
}
