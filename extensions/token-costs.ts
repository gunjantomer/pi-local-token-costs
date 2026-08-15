/**
 * Token Cost Tracking Extension for Pi Agent.
 *
 * Tracks token usage and cost estimates for every model in every session.
 * Shows live costs in the TUI footer, maintains cross-session history.
 *
 * Pricing source of truth: OpenRouter API (/api/v1/models), fetched at startup
 * and refreshed every 24 hours. For each cloud model, automatically selects the
 * cheapest provider across 30+ providers (Anthropic, OpenAI, Together AI, Groq,
 * Google Vertex, Mistral, Fireworks, DeepInfra, Anyscale, Perplexity, etc.).
 *
 * Model matching priority chain:
 *   1. User config override (~/.pi/agent/token-costs.json) — highest priority
 *   2. Live OpenRouter API (cheapest provider rate)
 *   3. Alias rules (regex for Ollama, vLLM, LM Studio naming conventions)
 *   4. Embedded fallback DB (~30 cloud models — works offline)
 *   5. Local model defaults ($0/$0 for unknown/local models)
 *
 * @module token-costs
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Type } from 'typebox';

import { generateMatrixHtml, type DayData } from '../lib/matrix-html';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single recorded token usage entry from an assistant message. */
interface CostEntry {
  /** Unix timestamp when the message was generated (ms). */
  timestamp: number;
  /** The model ID as reported by pi's current model context. */
  modelId: string;
  /** Provider prefix stripped from modelId, if any. */
  provider?: string;
  /** Number of input tokens consumed for this turn. */
  inputTokens: number;
  /** Number of output (completion) tokens generated for this turn. */
  outputTokens: number;
  /** Estimated cost for input tokens ($). Computed as `(inputTokens / 1M) × pricePerMillion`. */
  costInput: number;
  /** Estimated cost for output tokens ($). Computed as `(outputTokens / 1M) × pricePerMillion`. */
  costOutput: number;
  /** Cached input token cost ($), if the provider reported cache prices. */
  costCacheRead: number;
  /** Cached write cost ($), if the provider reported cache prices. */
  costCacheWrite: number;
  /** Total estimated cost for this turn in USD. Uses provider-reported total when available, otherwise `costInput + costOutput`. */
  costTotal: number;
}

/** Persisted history structure stored via pi.appendEntry(). */
interface CostHistory {
  /** Array of all recorded token usage entries across sessions. */
  entries: CostEntry[];
  /** Schema version for future migration support. Currently always 1. */
  version: number;
}

/** User-defined price override stored in ~/.pi/agent/token-costs.json.
 *  Takes highest priority over all other pricing sources (live API, fallback DB, aliases). */
interface PriceOverride {
  /** $ per 1M tokens for input. If omitted, falls back to `output` value or 0. */
  input?: number;
  /** $ per 1M tokens for output/completion. If omitted, falls back to `input` value or 0. */
  output?: number;
  /** Optional display label shown in history and stats UI instead of the raw model ID. */
  label?: string;
}

// ─── OpenRouter API Types ──────────────────────────────────────────────────

/** OpenRouter API pricing structure for a single provider.
 *  All values are raw $ per token (not per million). Multiply by 1,000,000 to get $/M tokens. */
interface ORProviderPricing {
  /** Cost per input token in USD. E.g., "0.000003" means $0.000003/token = $3.00/M tokens. */
  prompt: string;
  /** Cost per output/completion token in USD. E.g., "0.000015" means $0.000015/token = $15.00/M tokens. */
  completion: string;
  /** Optional cost per cached input token read (usually ~10% of prompt price). */
  input_cache_read?: string;
  /** Optional cost per cached token written (usually ~50% of completion price). */
  input_cache_write?: string;
}

/** A single model entry from the OpenRouter API response. */
interface ORModel {
  /** Canonical model ID, e.g., "anthropic/claude-sonnet-4" or "meta-llama/llama-3.3-70b-instruct". */
  id: string;
  /** Human-readable display name, e.g., "Anthropic: Claude Sonnet 4". */
  name: string;
  /** Pricing object with per-token costs from the current provider. */
  pricing: ORProviderPricing;
  /** Optional metadata about the top-ranked provider for this model. */
  top_provider?: { context_length?: number };
}

/** Top-level response structure from GET /api/v1/models on OpenRouter. */
interface ORApiResponse {
  /** Array of all available models with their pricing from each provider. */
  data: ORModel[];
}

/** Persisted cache of live pricing fetched from OpenRouter API.
 * Stored at ~/.pi/agent/token-costs-cache.json. Auto-managed by the extension — do not edit manually.
 * Cache is valid for 24 hours (CACHE_TTL_MS). Expired caches are automatically re-fetched on startup. */
interface LivePriceCache {
  /** Unix timestamp when this cache was written (ms). Used to determine if cache is still fresh. */
  timestamp: number;
  /** Map of normalized model names → { input, output } pricing in $ per 1M tokens. */
  models: Record<string, { input: number; output: number }>;
}

// ─── Embedded Fallback Database ─────────────────────────────────────────────
// Used ONLY when OpenRouter API is unreachable. Covers common local models
// and ensures the extension works offline. Cloud model prices are fetched live.

const FALLBACK_PRICES: Record<string, { input: number; output: number }> = {
  // Claude
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-opus-4': { input: 15.0, output: 75.0 },
  'claude-2.1': { input: 8.0, output: 24.0 },
  'claude-haiku-3': { input: 0.25, output: 1.25 },

  // OpenAI
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o3-pro': { input: 400.0, output: 800.0 },
  'o3-mini': { input: 2.75, output: 11.0 },

  // Google Gemini (Vertex AI pricing — OpenRouter may differ)
  'gemini-2.5-pro': { input: 1.25, output: 15.0 },
  'gemini-2.5-flash': { input: 0.15, output: 1.25 },
  'gemini-2.0-flash': { input: 0.15, output: 0.6 },

  // Mistral
  'mistral-large': { input: 2.0, output: 6.0 },
  'open-mistral-nemo': { input: 0.15, output: 0.15 },

  // Llama (Together AI pricing — OpenRouter may differ)
  'llama-3.3-70b-instruct': { input: 0.2, output: 0.4 },
  'llama-3.1-70b-instruct': { input: 0.3, output: 0.6 },

  // Qwen — OpenRouter cheapest provider pricing (per M tokens)
  // Free models
  'qwen3-next-80b-a3b-instruct:free': { input: 0.0, output: 0.0 },
  'qwen3-coder:free': { input: 0.0, output: 0.0 },
  // Qwen2.x
  'qwen-2-5-7b-instruct': { input: 0.04, output: 0.1 },
  'qwen-2-5-coder-32b-instruct': { input: 0.66, output: 1.0 },
  'qwen-2-5-72b-instruct': { input: 0.36, output: 0.4 },
  'qwen-2': { input: 0.36, output: 0.4 },
  // Qwen3.x — MoE variants (A3B)
  'qwen3-30b-a3b-instruct-2507': { input: 0.04815, output: 0.19305 },
  'qwen3-coder-30b-a3b-instruct': { input: 0.07, output: 0.27 },
  'qwen3-next-80b-a3b-instruct': { input: 0.09, output: 1.1 },
  'qwen3-235b-a22b-2507': { input: 0.09, output: 0.1 },
  'qwen3-next-80b-a3b-thinking': { input: 0.0975, output: 0.78 },
  'qwen3-6-35b-a3b': { input: 0.14, output: 1.0 },
  'qwen3-5-35b-a3b': { input: 0.14, output: 1.0 },
  'qwen3-235b-a22b-thinking-2507': { input: 0.1495, output: 1.495 },
  'qwen3-6-35b-a3b-instruct': { input: 0.14, output: 1.0 },
  'qwen3-5-35b-a3b-instruct': { input: 0.14, output: 1.0 },
  // Qwen3.x — dense variants
  'qwen3-32b': { input: 0.08, output: 0.28 },
  'qwen3-next': { input: 0.09, output: 1.1 },
  'qwen3-5-9b': { input: 0.1, output: 0.15 },
  'qwen3-14b': { input: 0.1, output: 0.24 },
  'qwen3-coder-next': { input: 0.11, output: 0.8 },
  'qwen3-8b': { input: 0.117, output: 0.455 },
  'qwen3-30b': { input: 0.12, output: 0.5 },
  'qwen3-30b-a3b': { input: 0.12, output: 0.5 },
  // Qwen3.x-VL (vision-language)
  'qwen3-vl-32b-instruct': { input: 0.104, output: 0.416 },
  'qwen3-vl-8b-thinking': { input: 0.117, output: 1.365 },
  'qwen3-vl-8b-instruct': { input: 0.117, output: 0.455 },
  'qwen3-vl-30b-a3b-thinking': { input: 0.13, output: 1.56 },
  'qwen3-vl-30b-a3b-instruct': { input: 0.13, output: 0.52 },
  // Qwen3.x — flash / fast variants
  'qwen3-5-flash-02-23': { input: 0.065, output: 0.26 },
  'qwen3-6-flash': { input: 0.1875, output: 1.125 },
  'qwen3-coder-flash': { input: 0.195, output: 0.975 },
  // Qwen3.x — Plus / Max tiers
  'qwen-plus-2025-07-28:thinking': { input: 0.26, output: 0.78 },
  'qwen-plus': { input: 0.26, output: 0.78 },
  'qwen-plus-2025-07-28': { input: 0.26, output: 0.78 },
  'qwen3-coder-plus': { input: 0.65, output: 3.25 },
  'qwen3-max-thinking': { input: 0.78, output: 3.9 },
  'qwen3-max': { input: 0.78, output: 3.9 },
  // Qwen3.x — Plus / Max tiers (alternate keys)
  'qwen3-6-plus': { input: 0.325, output: 1.95 },
  'qwen3-7-plus': { input: 0.32, output: 1.28 },
  'qwen3-7-max': { input: 1.25, output: 3.75 },
  // Qwen3.x — large dense
  'qwen3-6': { input: 0.325, output: 1.95 },
  'qwen3-5': { input: 0.385, output: 2.45 },
  'qwen3-5-122b-a10b': { input: 0.26, output: 2.08 },
  'qwen3-5-plus-02-15': { input: 0.26, output: 1.56 },
  'qwen3-5-plus-20260420': { input: 0.3, output: 1.8 },
  'qwen3-5-397b-a17b': { input: 0.385, output: 2.45 },
  'qwen3-6-27b': { input: 0.285, output: 2.4 },
  'qwen3-8-27b': { input: 0.45, output: 3.2 },
  'qwen3-6-max-preview': { input: 1.04, output: 6.24 },
  'qwen3-7': { input: 1.25, output: 3.75 },
  // Qwen3.x — very large
  'qwen3-235b': { input: 0.455, output: 1.82 },
  'qwen3-235b-a22b': { input: 0.455, output: 1.82 },
  // Qwen-VL
  'qwen2-5-vl-72b-instruct': { input: 0.8, output: 1.0 },
  'qwen2-5': { input: 0.8, output: 1.0 },
  // Qwen3-VL family
  'qwen3-vl': { input: 0.2, output: 0.88 },
  'qwen3-vl-235b-a22b-instruct': { input: 0.2, output: 0.88 },
  'qwen3-vl-235b-a22b-thinking': { input: 0.26, output: 2.6 },

  // Qwen dot-preserved variants (LM Studio / Ollama report model IDs with dots)
  // These ensure direct fallback matching without needing stripping for common local model names.
  'qwen3.6-35b-a3b': { input: 0.14, output: 1.0 },
  'qwen3.6-35b-a3b-instruct': { input: 0.14, output: 1.0 },
  'qwen3.6-27b': { input: 0.285, output: 2.4 },
  'qwen3.8-27b': { input: 0.45, output: 3.2 },
  'qwen3.6-flash': { input: 0.1875, output: 1.125 },
  'qwen3.6-plus': { input: 0.325, output: 1.95 },
  'qwen3.6-max-preview': { input: 1.04, output: 6.24 },
  'qwen3.5-35b-a3b': { input: 0.14, output: 1.0 },
  'qwen3.5-35b-a3b-instruct': { input: 0.14, output: 1.0 },
  'qwen3.5-9b': { input: 0.1, output: 0.15 },
  'qwen3.5-14b': { input: 0.1, output: 0.24 },
  'qwen3.5-plus-02-15': { input: 0.26, output: 1.56 },
  'qwen3.5-plus-20260420': { input: 0.3, output: 1.8 },
  'qwen2.5-coder-32b': { input: 0.66, output: 1.0 },
  'qwen2.5-coder': { input: 0.66, output: 1.0 },

  // Qwen quantized GGUF variants (LM Studio reports full filenames like Q4_K_M)
  'qwen3.6-35b-a3b-q4-k-m': { input: 0.14, output: 1.0 },
  'qwen3.6-35b-a3b-q8_0': { input: 0.14, output: 1.0 },
  'qwen3.6-35b-a3b-fp16': { input: 0.14, output: 1.0 },

  // Gemma base models (OpenRouter cheapest provider)
  'gemma4-base': { input: 0.1, output: 0.2 },
  'gemma3-base': { input: 0.1, output: 0.2 },

  // Cohere
  'command-r-plus': { input: 2.5, output: 10.0 },
};

/** Local model aliases that likely won't appear in OpenRouter */
const LOCAL_MODEL_DEFAULTS: Record<string, { input: number; output: number }> =
  {
    // Ollama / LM Studio style naming (not in OpenRouter)
    'llama3.3': { input: 0.0, output: 0.0 },
    'llama3.1': { input: 0.0, output: 0.0 },
    'llama3.2': { input: 0.0, output: 0.0 },
    'mistral-nemo': { input: 0.0, output: 0.0 },
    phi4: { input: 0.0, output: 0.0 },
    'phi3.5': { input: 0.0, output: 0.0 },
    gemma2: { input: 0.0, output: 0.0 },
    'deepseek-coder-v2': { input: 0.0, output: 0.0 },
  };

// ─── Model Alias Map ──────────────────────────────────────────────────────
// Maps normalized model identifiers → canonical OpenRouter DB key or fallback.

interface AliasRule {
  pattern: RegExp;
  target: string;
}

const ALIAS_RULES: AliasRule[] = [
  // Qwen family — covers Qwen2, Qwen2.5, Qwen3 with various suffixes
  { pattern: /qwen[\s./-]*2\.5[\s./-]*coder/i, target: 'qwen2.5-coder' },
  { pattern: /qwen[\s./-]*2[\s./-]*coder/i, target: 'qwen2-coder' },
  // Qwen3.x with param count captured — matches specific sizes like 9b, 35b-a3b
  {
    pattern: /qwen[\s./-]*3\.\d+[\s./-]*(?:\d+[bmBMk]+)/i,
    target: 'qwen3-param',
  },
  // Qwen3.x base models without explicit param count (e.g., qwen3.6 → matches against OR key)
  { pattern: /qwen[\s./-]*3\.\d+/i, target: 'qwen3-base' },
  { pattern: /qwen[\s./-]*3/i, target: 'qwen3-base' },

  // Llama family with parameter counts
  { pattern: /llama\s*3\.3.*70b/i, target: 'llama-3.3-70b-instruct' },
  { pattern: /llama\s*3\.1.*405b/i, target: 'llama-3.1-405b-instruct' },
  { pattern: /llama\s*3\.1.*70b/i, target: 'llama-3.1-70b-instruct' },

  // Short names → OR model keys (not local defaults) so comparison pricing works
  { pattern: /^ollama\/?llama3\.3$/i, target: 'llama-3.3-70b-instruct' },
  { pattern: /^ollama\/?llama3\.2$/i, target: 'llama-3.2-11b-vision-instruct' },
  { pattern: /^ollama\/?llama3\.1$/i, target: 'llama-3.1-70b-instruct' },

  // Mistral
  { pattern: /mistral[\s./-]*nemo/i, target: 'mistral-nemo' },
  { pattern: /mistral[\s./-]*large/i, target: 'mistral-large' },

  // Phi
  { pattern: /^phi\s*4$/i, target: 'phi4' },

  // Gemma family (Gemma2, Gemma3, Gemma4 with A3B/QAT variants)
  { pattern: /gemma[\s./-]*2/i, target: 'gemma2' },
  { pattern: /gemma\s*3/i, target: 'gemma3-base' },
  { pattern: /gemma\s*[45]\b/i, target: 'gemma4-base' },

  // DeepSeek Coder
  { pattern: /deepseek[\s./-]*coder/i, target: 'deepseek-coder-v2' },

  // Qwen general (catch-all for any qwen model not matched above)
  { pattern: /^qwen[\s./-]*/i, target: 'qwen-base' },
];

// ─── Cache Path ─────────────────────────────────────────────────────────────

function getCachePath(): string | undefined {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return undefined;
  return join(home, '.pi', 'agent', 'token-costs-cache.json');
}

// ─── User Config Path ──────────────────────────────────────────────────────

function getConfigPath(): string {
  return join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.pi',
    'agent',
    'token-costs.json',
  );
}

// ─── Cross-Session History File ─────────────────────────────────────────────

/** Persisted history file that survives across sessions.
 *  Stored at ~/.pi/agent/token-cost-history.json */
function getHistoryPath(): string {
  return join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.pi',
    'agent',
    'token-cost-history.json',
  );
}

/** Load entries from the cross-session history file. */
function loadHistoryFromFile(): CostEntry[] {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.entries)) return raw.entries;
  } catch {
    // Ignore parse errors
  }
  return [];
}

/** Append an entry to the cross-session history file. */
function appendToHistoryFile(entry: CostEntry): void {
  const path = getHistoryPath();
  try {
    const existing = loadHistoryFromFile();
    existing.push(entry);
    writeFileSync(path, JSON.stringify(existing, null, 2), 'utf8');
  } catch (err) {
    console.error('[token-costs] Failed to write history file:', err);
  }
}

function loadUserConfig(): Record<string, PriceOverride> {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return typeof raw === 'object' && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

// ─── OpenRouter API Integration ─────────────────────────────────────────────

/** A minimal price entry — only the two numeric fields. */
type MinPrice = { input: number; output: number };

/** Live pricing map: normalized model name → cheapest provider's { input, output } in $/M tokens */
const livePrices: Map<string, { input: number; output: number }> = new Map();
/** Reverse lookup: normalized name → canonical OpenRouter model ID */
const modelIdMap: Map<string, string> = new Map();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Fetch pricing from OpenRouter API and build live lookup maps. Returns true on success. */
async function fetchLivePricing(): Promise<boolean> {
  // Check cache first
  const cachePath = getCachePath();
  if (cachePath && existsSync(cachePath)) {
    try {
      const cached: LivePriceCache = JSON.parse(
        readFileSync(cachePath, 'utf8'),
      );
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        console.log('[token-costs] Using cached pricing data');
        livePrices.clear();
        modelIdMap.clear();
        for (const [key, price] of Object.entries(cached.models)) {
          livePrices.set(key.toLowerCase(), price);
          modelIdMap.set(key.toLowerCase(), key);
        }
        // Migrate: register clean variants from cached keys so local models can match.
        // This mirrors what registerVariants does for fresh fetches, but runs on existing cache.
        let migrated = 0;
        for (const [key, price] of Object.entries(cached.models)) {
          const parts = key.toLowerCase().split('-');
          if (
            parts.length >= 3 &&
            /^[a-z]+$/i.test(parts[0]) &&
            parts[1].startsWith(parts[0])
          ) {
            // Duplicate org-prefix detected. Two cases:
            //   Exact dup: "deepseek-deepseek-chat" → skip to parts[2:] = "chat"... no, keep model name: parts[1:] = "deepseek-chat"
            //   Partial dup: "qwen-qwen3-6" → skip only the org prefix: parts[1:] = "qwen3-6"
            const isExactDup = parts[0] === parts[1];
            const sliceStart = isExactDup ? 2 : 1;
            const strippedKey = parts.slice(sliceStart).join('-');
            if (
              strippedKey.toLowerCase() &&
              !livePrices.has(strippedKey.toLowerCase())
            ) {
              livePrices.set(strippedKey.toLowerCase(), price);
              modelIdMap.set(strippedKey.toLowerCase(), key);
              migrated++;
            }
            // Also register base variant without param count
            const withoutParam = strippedKey.replace(
              /-\d+[bmBMk]+(?:-[a-z0-9]+)*$/,
              '',
            );
            if (withoutParam && !parts[sliceStart].match(/^\d+[bmBMk]+$/)) {
              const bpLower = withoutParam.toLowerCase();
              if (!livePrices.has(bpLower)) {
                livePrices.set(bpLower, price);
                modelIdMap.set(bpLower, key);
                migrated++;
              }
            }
            // Also register family-only key (e.g., "qwen3", "gemma4")
            const famVersion = parts[sliceStart]?.split('-')[0];
            if (
              famVersion &&
              !famVersion.match(/^\d+$/) &&
              !/^[a-z]+$/i.test(famVersion)
            ) {
              const famLower = famVersion.toLowerCase();
              if (!livePrices.has(famLower)) {
                livePrices.set(famLower, price);
                modelIdMap.set(famLower, key);
                migrated++;
              }
            }
          } else if (
            parts.length >= 2 &&
            /^[a-z]+$/i.test(parts[0]) &&
            /^\d/.test(parts[1])
          ) {
            // Family name + number without dash: "gemma-4" in cache → also register as "gemma4" for local models.
            // This handles cases where local models normalize to "gemma4" but cache has "gemma-4", etc.
            const noDashKey = `${parts[0]}${parts.slice(1).join('-')}`;
            if (!livePrices.has(noDashKey.toLowerCase())) {
              livePrices.set(noDashKey.toLowerCase(), price);
              modelIdMap.set(noDashKey.toLowerCase(), key);
              migrated++;
            }
          }
        }
        if (migrated > 0) {
          console.log(
            `[token-costs] Migrated ${migrated} variants from cache for local matching`,
          );
        }
        return true;
      }
    } catch {
      /* corrupted cache, fall through to fetch */
    }
  }

  try {
    console.log('[token-costs] Fetching live pricing from OpenRouter API...');
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(30_000), // 30 second timeout
    });

    if (!response.ok) {
      console.warn(
        `[token-costs] OpenRouter API returned ${response.status}, using fallback`,
      );
      return false;
    }

    const data: ORApiResponse = await response.json();
    let count = 0;

    for (const model of data.data) {
      const promptPrice = parseFloat(model.pricing.prompt || '0');
      const completionPrice = parseFloat(model.pricing.completion || '0');

      if (!isFinite(promptPrice) && !isFinite(completionPrice)) continue;

      // Normalize the model ID for lookup
      const normalized = normalizeModelName(model.id);
      const inputPrice = promptPrice * 1_000_000; // $/M tokens
      const outputPrice = completionPrice * 1_000_000;

      // Select the cheapest provider rate for this model.
      // OpenRouter returns one entry per provider — we keep only the minimum
      // input and output prices across all providers offering this model.
      const existing = livePrices.get(normalized);
      if (existing) {
        existing.input = Math.min(existing.input, inputPrice);
        existing.output = Math.min(existing.output, outputPrice);
      } else {
        livePrices.set(normalized, { input: inputPrice, output: outputPrice });
      }
      modelIdMap.set(normalized, model.id);
      count++;

      // Also register common variant normalizations (with cheapest rate)
      registerVariants(normalized, inputPrice, outputPrice);
    }

    // Save to cache
    const cacheData: LivePriceCache = {
      timestamp: Date.now(),
      models: Object.fromEntries(livePrices),
    };
    if (cachePath) {
      writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    }

    console.log(
      `[token-costs] Loaded live pricing for ${count} models from OpenRouter`,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[token-costs] Failed to fetch OpenRouter API: ${msg}. Using fallback.`,
    );
    return false;
  }
}

/** Register additional normalized variants for a model ID so fuzzy matching works.
 *
 *  IMPORTANT: Only registers stripped variants if they DON'T already exist in
 *  livePrices. This prevents later-processed models (e.g., qwen3-6-9b) from
 *  overwriting earlier ones (e.g., qwen3-6-235B-A3B) when both collapse to the
 *  same stripped key like "qwen3-6". Param-count-specific entries always win.
 */
function registerVariants(key: string, input: number, output: number): void {
  const parts = key.split('-');

  // Register without version suffixes (e.g., "claude-sonnet" from "claude-sonnet-5")
  if (parts.length >= 2) {
    const baseKey = `${parts[0]}-${parts[1]}`;
    if (!livePrices.has(baseKey)) {
      livePrices.set(baseKey, { input, output });
    }
  }

  // Register stripped variant when org-prefix duplication occurs with exactly 2 parts.
  //   "qwen-qwen2" → also store as "qwen2" so local models can match directly
  if (
    parts.length === 2 &&
    /^[a-z]+$/i.test(parts[0]) &&
    parts[1].startsWith(parts[0])
  ) {
    const strippedKey = parts[1];
    if (!livePrices.has(strippedKey)) {
      livePrices.set(strippedKey, { input, output });
    }
  }

  // Register just the model family name (e.g., "sonnet" from "claude-sonnet")
  if (parts.length >= 3 && parts[0] === 'claude') {
    const famKey = parts.slice(1).join('-');
    if (!livePrices.has(famKey)) {
      livePrices.set(famKey, { input, output });
    }
  }

  // Register version-normalized key without duplicate org-prefix.
  //   "qwen-qwen3-6" → also store as "qwen3-6" so local models can match directly
  if (
    parts.length >= 3 &&
    /^[a-z]+$/i.test(parts[0]) &&
    parts[1].startsWith(parts[0])
  ) {
    const isExactDup = parts[0] === parts[1];
    const sliceStart = isExactDup ? 2 : 1;
    const strippedKey = parts.slice(sliceStart).join('-');

    // Register the stripped key (e.g., "qwen3-6", "chat") — only if not already set
    if (strippedKey && !livePrices.has(strippedKey)) {
      livePrices.set(strippedKey, { input, output });
    }

    // Also register base variant without param count for family-level matching.
    // Only register if no more-specific entry (with params) already exists.
    const withoutParam = strippedKey.replace(
      /-\d+[bmBMk]+(?:-[a-z0-9]+)*$/,
      '',
    );
    if (
      withoutParam &&
      !parts[sliceStart].match(/^\d+[bmBMk]+$/) &&
      !livePrices.has(withoutParam)
    ) {
      livePrices.set(withoutParam, { input, output });
    }

    // Also register family-only key (e.g., "qwen3", "gemma4") when parts[1] is a variant name
    if (!isExactDup && sliceStart < parts.length) {
      const famVersion = parts[sliceStart].split('-')[0];
      if (
        famVersion &&
        !famVersion.match(/^\d+$/) &&
        !/^[a-z]+$/i.test(famVersion) &&
        !livePrices.has(famVersion)
      ) {
        livePrices.set(famVersion, { input, output });
      }
    }
  }
}

/** Normalize an OpenRouter model ID for consistent lookup. */
function normalizeModelName(orId: string): string {
  let id = orId;
  // Strip provider prefix (openai/, anthropic/, google/, etc.) and HuggingFace org names
  id = id.replace(/^[A-Za-z0-9_-]+\//i, '');
  // Lowercase and collapse separators. OpenRouter keys use dots in version numbers
  // (e.g., "qwen/qwen3.6-35b-a3b"), so we preserve dots while collapsing other
  // separators to dashes for consistent matching.
  return id.toLowerCase().replace(/[\s_/-]+/g, '-');
}

/** Load fallback pricing from embedded database */
function loadFallbackPricing(): void {
  for (const [key, price] of Object.entries(FALLBACK_PRICES)) {
    livePrices.set(key.toLowerCase(), price);
    modelIdMap.set(key.toLowerCase(), key);

    // Register dot-preserved variant for Qwen models.
    // Local models normalize with dots preserved (e.g. "qwen3.6-35b")
    // while OpenRouter cache uses dashes in version numbers ("qwen3-6"). Both must match.
    if (/^qwen[23]/i.test(key)) {
      const dotKey = key.replace(/^([a-z]+)(\d+)-(\d+)(?=-|$)/, '$1$2.$3'); // "qwen3-6-35b" → "qwen3.6-35b"
      if (dotKey !== key && !livePrices.has(dotKey.toLowerCase())) {
        livePrices.set(dotKey.toLowerCase(), price);
        modelIdMap.set(dotKey.toLowerCase(), key);
      }
    }

    // Also register family-only variant (e.g. "qwen3", "qwen2")
    const famMatch = key.match(
      /^(qwen[23]?|gemma\d?|llama[\d.-]+|mistral)(?:-.*)?$/,
    );
    if (famMatch) {
      const familyKey = famMatch[1].toLowerCase();
      if (!livePrices.has(familyKey)) {
        // Only register if this key is more specific than existing
        const existingPrice = livePrices.get(familyKey);
        if (!existingPrice || price.input < existingPrice.input) {
          livePrices.set(familyKey, price);
          modelIdMap.set(familyKey, key);
        }
      }
    }
  }

  for (const [key, price] of Object.entries(LOCAL_MODEL_DEFAULTS)) {
    livePrices.set(key.toLowerCase(), price);
    modelIdMap.set(key.toLowerCase(), key);

    // Also register dot-preserved variants for Qwen local models
    if (/^qwen[23]/i.test(key)) {
      const dotKey = key.replace(/^([a-z]+)(\d+)-(\d+)(?=-|$)/, '$1$2.$3');
      if (dotKey !== key && !livePrices.has(dotKey.toLowerCase())) {
        livePrices.set(dotKey.toLowerCase(), price);
        modelIdMap.set(dotKey.toLowerCase(), key);
      }
    }
  }
}

// ─── Targeted Per-Model Price Fetch ──────────────────────────────────────
// The full OpenRouter list is cached for 24h, so a newly released model can be
// missing from local pricing for up to a day after launch. When the active
// model resolves to nothing (source "local-default"), we make one fresh
// OpenRouter call and match just that model — no source edits needed for new
// releases. The param count (e.g. "27b") is preserved in every lookup
// candidate: pricing varies by model size, so a family-level or different-size
// model's price is never substituted.

/** Models already targeted-fetched this process — avoids retry storms on session restarts. */
const _targetedFetchAttempted = new Set<string>();

/** Write current livePrices to the cache file, preserving a still-fresh timestamp. */
function persistLivePriceCache(): void {
  try {
    const path = getCachePath();
    if (!path) return;
    let timestamp = Date.now();
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, 'utf8')) as LivePriceCache;
      if (Date.now() - existing.timestamp < CACHE_TTL_MS) {
        // We only added models on top of a fresh cache — keep its timestamp.
        timestamp = existing.timestamp;
      }
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        { timestamp, models: Object.fromEntries(livePrices) },
        null,
        2,
      ),
    );
  } catch (err) {
    console.warn(`[token-costs] Failed to persist price cache: ${err}`);
  }
}

/** Build lookup candidates for a model ID, most specific first.
 *
 * The param count is never stripped — a 27B model must not be priced from a
 * 35B sibling or a family-level key. Candidates vary only in quantization
 * tags, variant suffixes, org-prefix duplication, and dot/dash spelling. */
export function buildLookupCandidates(modelId: string): string[] {
  const normalized = normalizeModelId(modelId);
  const out: string[] = [normalized];

  // Strip GGUF quantization tag — keep param count
  const dequant = normalized.replace(
    /-[qbf][p]?[0-9]+(?:[_-][a-z0-9]+)*(?:-[kK]_[mMsS]|_[0-9])*(?:-[fF]16|[bB]f16)?$/i,
    '',
  );
  if (dequant && dequant !== normalized) out.push(dequant);

  // Strip trailing variant/semantic suffix — keep param count
  const noVariant = out[out.length - 1].replace(
    /-(?:instruct|chat|turbo|h|gq|i1)(?:-[0-9]+)?$/i,
    '',
  );
  if (noVariant && !out.includes(noVariant)) out.push(noVariant);

  // Strip org-prefix duplication ("qwen-qwen3.8-27b" → "qwen3.8-27b") — keep param count
  const parts = normalized.split('-');
  if (parts.length >= 2 && /^[a-z]+$/i.test(parts[0])) {
    out.push(parts.slice(1).join('-'));
  }

  // Dot/dash version spelling: OpenRouter keys use dots ("qwen3.8-27b"),
  // local model IDs often use dashes ("qwen3-8-27b"). Try both spellings.
  const expanded: string[] = [];
  for (const c of out) {
    if (expanded.includes(c)) continue;
    expanded.push(c);
    const dotted = c.replace(/^([a-z]+)(\d+)-(\d+)(?=-|$)/, '$1$2.$3');
    if (dotted !== c) expanded.push(dotted);
  }

  return [...new Set(expanded)];
}

/** Fetch fresh pricing for one specific model from OpenRouter, bypassing the
 *  24h cache so newly released models are found immediately.
 *  Returns true if a price was found and registered. */
export async function fetchPriceForModel(
  modelId: string,
  onResolved?: (orId: string, price: MinPrice) => void,
): Promise<boolean> {
  const normalized = normalizeModelId(modelId);
  if (_targetedFetchAttempted.has(normalized)) return false;

  // Already resolvable from local sources? Nothing to do.
  if (resolveModel(modelId).source !== 'local-default') return true;

  _targetedFetchAttempted.add(normalized);
  try {
    console.log(
      `[token-costs] "${modelId}" not in local pricing — fetching fresh from OpenRouter...`,
    );
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(
        `[token-costs] Targeted price fetch failed: HTTP ${response.status}`,
      );
      return false;
    }
    const data: ORApiResponse = await response.json();

    for (const candidate of buildLookupCandidates(modelId)) {
      // One list entry per provider offering this model.
      const matches = data.data.filter(
        (m) => normalizeModelName(m.id) === candidate,
      );
      if (matches.length === 0) continue;

      // Cheapest provider wins — per-field min, consistent with the full fetch.
      let bestIn = Infinity;
      let bestOut = Infinity;
      let bestId = '';
      for (const m of matches) {
        const input = parseFloat(m.pricing.prompt || '0') * 1_000_000;
        const output = parseFloat(m.pricing.completion || '0') * 1_000_000;
        if (!isFinite(input) && !isFinite(output)) continue;
        if (isFinite(input) && input < bestIn) bestIn = input;
        if (isFinite(output) && output < bestOut) bestOut = output;
        if (!bestId) bestId = m.id;
      }
      if (!bestId || (!isFinite(bestIn) && !isFinite(bestOut))) continue;

      const price: MinPrice = {
        input: isFinite(bestIn) ? bestIn : 0,
        output: isFinite(bestOut) ? bestOut : 0,
      };

      // Register under the matched candidate AND the original normalized ID so
      // future resolveModel() calls direct-hit at step 3.
      livePrices.set(candidate, price);
      modelIdMap.set(candidate, bestId);
      if (candidate !== normalized) {
        livePrices.set(normalized, price);
        modelIdMap.set(normalized, bestId);
      }
      registerVariants(candidate, price.input, price.output);
      persistLivePriceCache();

      console.log(
        `[token-costs] Found pricing for ${modelId} → ${bestId} ($${price.input.toFixed(5)} / $${price.output.toFixed(5)} per M)`,
      );
      onResolved?.(bestId, price);
      return true;
    }

    console.log(
      `[token-costs] No OpenRouter match for "${modelId}" — treating as local/free`,
    );
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[token-costs] Targeted price fetch failed: ${msg}`);
    return false;
  }
}

// ─── Model Matching Logic ──────────────────────────────────────────────────

/** Normalize a model ID for matching. */
function normalizeModelId(modelId: string): string {
  let id = modelId.trim();

  // Strip Windows/Linux file paths (LM Studio, Ollama local serving, etc.)
  // e.g., "/path/to/qwen2.5-coder-32b.Q4_K_M.gguf" → "qwen2.5-coder-32b"
  id = id.replace(/.*[/\\]/g, ''); // Remove directory prefix + trailing slash
  id = id
    .replace(/\.gguf$/i, '')
    .replace(/\.safetensors$/i, '')
    .replace(/\.bin$/i, '');

  // Strip provider prefixes
  id = id.replace(
    /^(openai|anthropic|google|mistral|ollama|together|fireworks|deepinfra|anyscale|perplexity|bedrock|vertex)\//i,
    '',
  );
  // Strip HuggingFace org prefix (handles multi-segment like meta-llama/)
  id = id.replace(/^(?:[A-Za-z0-9_-]+\/)+/g, '');

  // Remove version/variant suffixes
  id = id.replace(
    /(:|-)(?:free|latest|preview|v\d+|[bc]\d+|thinking|turbo|chat)/gi,
    '',
  );

  // Lowercase and collapse separators. OpenRouter keys use dots in version numbers
  // (e.g., "qwen/qwen3.6-35b-a3b"), so we preserve dots while collapsing other
  // separators to dashes for consistent matching.
  return id.toLowerCase().replace(/[\s_/-]+/g, '-');
}

/** Extract a human-readable model name from potentially raw identifiers (paths, IDs, etc.) */
function extractModelName(rawId: string): string {
  let name = rawId;

  // Strip Windows/Linux file paths — LM Studio reports models as full paths
  name = name.replace(/.*[/\\]/g, ''); // Remove directory prefix + trailing slash
  // Strip common model file extensions (.gguf, .mlx, .bin, etc.)
  name = name
    .replace(/\.gguf$/i, '')
    .replace(/\.mlx$/i, '')
    .replace(/\.safetensors$/i, '')
    .replace(/\.bin$/i, '');
  // Strip quantization tags from filename stem (e.g., .Q4_K_M, _Q8_0 before extension was removed)
  name = name
    .replace(
      /[._-](?:Q[0-9][A-Z]*|F16|BF16|F32)[._-]?[A-Za-z0-9]*(?:[_-][kK]_[mMsS])?$/i,
      '',
    )
    .replace(/[-_]Q[0-9][A-Za-z0-9_]*(?:[_-][kK]_[mMsS])?$/gi, '')
    .replace(/[-_]F16$/i, '')
    .replace(/[-_]BF16$/i, '')
    .replace(/[-_]F32$/i, '');
  // Strip HuggingFace org prefix
  name = name.replace(/^(?:[A-Za-z0-9_-]+\/)+/g, '');
  // Remove date stamps and version suffixes
  name = name
    .replace(/-[0-9]{4}-[0-9]{2}-[0-9]{2}/g, '')
    .replace(/(:|-)(free|latest|preview|v\d+|b\d+)/gi, '');

  // Apply nice-name capitalization
  const niceNames: Record<string, string> = {
    claude: 'Claude',
    gpt: 'GPT',
    gemini: 'Gemini',
    llama: 'Llama',
    qwen: 'Qwen',
    phi: 'Phi',
    mistral: 'Mistral',
    deek: 'DeepSeek',
    nemotron: 'Nemotron',
  };

  for (const [prefix, nice] of Object.entries(niceNames)) {
    if (name.toLowerCase().startsWith(prefix)) {
      name = name.replace(new RegExp(`^${prefix}`, 'i'), nice);
      break;
    }
  }

  return name || rawId;
}

/** Try to find a live price by matching against stripped variants.
 *
 *  Strategy: walk through progressively stripped forms of the normalized ID
 *  and check each against the live prices map. This handles cases where
 *  OpenRouter stores "qwen/qwen3-6" but the local model is reported as
 *  "Qwen/Qwen3.6-35B-A3B-Instruct".
 *
 *  Matching order (most specific → least specific):
 *    A. GGUF quantization tag removal only — preserves param counts, variant tags, semantic suffixes
 *       "qwen2-5-coder-32b-q4-k-m" → "qwen2-5-coder-32b"
 *    B. Strip trailing date stamps (e.g., -2507) and semantic suffixes (-instruct, etc.)
 *       "qwen3-6-35b-a3b-instruct-2507" → "qwen3-6-35b-a3b"
 *    C. Strip variant tags (-a3b, -qat) while KEEPING param count
 *       "qwen3-6-35b-a3b" → "qwen3-6-35b"
 *    D. Strip variant tags + semantic suffixes, KEEPING param count
 *       "qwen3-6-35b-a3b-instruct" → "qwen3-6-35b"
 *    E. Strip param count + variants together (fallback)
 *       "qwen3-6-35b-a3b" → "qwen3-6"
 *    F. Org-prefix duplication removal
 *    G. Family name + version fallback
 *    H. Substring matching — last resort
 */
function findLivePriceByStripping(
  normalized: string,
): { price: { input: number; output: number }; orId: string } | null {
  const candidates = new Set<string>();

  // Strategy A: Strip GGUF-style quantization tags before param stripping.
  //   "qwen2-5-coder-32b-q4-k-m" → "qwen2-5-coder-32b"
  let result = normalized.replace(
    /-[qbfQBF][pP]?[0-9]+(?:[_-][a-z0-9]+)*(?:-[kK]_[mMsS]|_[0-9])*(?:-[fF]16|[bB]f16)?$/i,
    '',
  );
  if (result.trim() && result !== normalized) candidates.add(result.trim());

  // Strategy B: Strip trailing date stamps and semantic suffixes while KEEPING
  // param counts AND variant tags. This is critical — OpenRouter keys like
  // "qwen3-6-35b-a3b-instruct" include these, so we must try the full key first.
  //   "qwen3-6-35b-a3b-instruct-2507" → "qwen3-6-35b-a3b"
  //   "qwen3-6-35b-a3b-instruct"      → "qwen3-6-35b-a3b"
  result = normalized.replace(
    /-(?:instruct|chat|turbo|h|gq|i1)(?:-[0-9]+)?$/i,
    '',
  );
  if (result.trim() && result !== normalized) candidates.add(result.trim());

  // Strategy C: Strip variant tags (-a3b, -qat, etc.) while KEEPING param count.
  //   "qwen3-6-35b-a3b" → "qwen3-6-35b"
  result = normalized.replace(
    /-\d+[bmBMk]+(?:-(?:a3b|qat))+(?:-[a-z0-9]+)*$/,
    '',
  );
  if (result.trim() && result !== normalized) candidates.add(result.trim());

  // Strategy D: Strip variant tags + semantic suffixes, KEEPING param count.
  //   "qwen3-6-35b-a3b-instruct" → "qwen3-6-35b"
  result = normalized.replace(
    /-\d+[bmBMk]+(?:-(?:a3b|qat))+(?:-[a-z0-9]+)*(?::|-)?(instruct|chat|turbo|h|gq|i1)?$/i,
    '',
  );
  if (result.trim() && result !== normalized) candidates.add(result.trim());

  // Strategy E: Strip param count + variants together.
  //   "qwen3-6-35b-a3b" → "qwen3-6"
  result = normalized.replace(
    /-\d+[bmBMk]+(?:-(?:a3b|qat))+(?:-[a-z0-9]+)*$/,
    '',
  );
  if (result.trim() && result !== normalized) candidates.add(result.trim());

  // Strategy E2: Strip trailing param count only.
  //   "qwen3-6-35b" → "qwen3-6"
  result = normalized.replace(/-\d+[bmBMk]+$/, '');
  if (result.trim() && result !== normalized) candidates.add(result.trim());

  // Strategy E: Remove org-prefix duplication.
  const parts = normalized.split('-');
  if (parts.length >= 2 && /^[a-z]+$/i.test(parts[0])) {
    const skipPrefixes = [
      'openai',
      'anthropic',
      'google',
      'meta-llama',
      'mistral',
    ];
    if (!skipPrefixes.some((p) => parts[0].startsWith(p))) {
      candidates.add(parts.slice(1).join('-'));

      // Also try stripping prefix + next segment if it's a duplicate
      // e.g., "qwen-qwen3-6" → also try just "qwen3-6" (parts 2+)
      if (parts.length >= 3 && parts[1].startsWith(parts[0])) {
        candidates.add(parts.slice(2).join('-'));
      }

      // Try org-prefix version with param count from original.
      // e.g., "qwen-qwen3-6-35b-a3b" → try "qwen3-6-35b"
      const paramMatch = normalized.match(/(-\d+[bmBMk]+)$/);
      if (paramMatch && parts.length >= 2) {
        // Reconstruct without org prefix but keeping param count
        candidates.add(parts.slice(1).join('-').replace(paramMatch[0], ''));
      }
    }
  }

  // Strategy F: Try just the model family name + version.
  const famMatch = normalized.match(
    /^(qwen|llama|gemma|phi|claude|gemini|mistral)([\d.-].*)?$/i,
  );
  if (famMatch) {
    candidates.add(famMatch[1].toLowerCase());
    // Also try family + version (e.g., "gemma4", "qwen3-6")
    const famVersion = famMatch[2]?.split('-')[0];
    if (famVersion && famVersion !== 'instruct') {
      candidates.add(`${famMatch[1]}-${famVersion}`);
    }
  }

  // Search live prices for any candidate — first match wins,
  // which is the most specific strategy due to insertion order.
  const normalizedLower = normalized.toLowerCase();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase().replace(/[\s._/-]+/g, '-');
    if (livePrices.has(key)) {
      return { price: livePrices.get(key)!, orId: modelIdMap.get(key) || key };
    }
  }

  // Strategy G: Last resort — partial substring match.
  for (const [liveKey, livePrice] of livePrices.entries()) {
    const lk = liveKey.toLowerCase();
    if (
      (normalizedLower.includes(lk) || lk.includes(normalizedLower)) &&
      (livePrice.input > 0 || livePrice.output > 0)
    ) {
      return { price: livePrice, orId: modelIdMap.get(liveKey) || liveKey };
    }
  }

  return null;
}

/** Resolve a model ID to an online-equivalent price via alias rules.
 * Returns undefined if no cloud match is found. Used for local models
 * so users can see what they're saving by running locally vs online. */
function resolveOnlineEquivalent(modelId: string): MinPrice | undefined {
  for (const rule of ALIAS_RULES) {
    if (rule.pattern.test(modelId)) {
      const target = rule.target;
      const lp = livePrices.get(target.toLowerCase());
      if (lp && (lp.input > 0 || lp.output > 0)) return lp;
    }
  }
  return undefined;
}

/**
 * Resolve a model ID to pricing.
 * Priority: user config → live OpenRouter (cheapest provider) → alias rules → fallback DB → free default
 */
function resolveModel(modelId: string): {
  key: string;
  price: { input: number; output: number };
  source: string;
  /** For local/free models, the cheapest online-equivalent price (if available). */
  comparableOnlinePrice?: MinPrice;
} {
  const config = loadUserConfig();

  // 1. User config (exact match)
  if (config[modelId]) {
    return {
      key: modelId,
      price: {
        input: config[modelId].input ?? config[modelId].output ?? 0,
        output: config[modelId].output ?? config[modelId].input ?? 0,
      },
      source: 'user-config',
    };
  }

  const normalized = normalizeModelId(modelId);

  // 2. User config (normalized match)
  if (config[normalized]) {
    return {
      key: normalized,
      price: {
        input: config[normalized].input ?? config[normalized].output ?? 0,
        output: config[normalized].output ?? config[normalized].input ?? 0,
      },
      source: 'user-config',
    };
  }

  // 3. Live OpenRouter pricing (cheapest provider across 30+ providers)
  const livePrice = livePrices.get(normalized);
  if (livePrice && (livePrice.input > 0 || livePrice.output > 0)) {
    const orId = modelIdMap.get(normalized) || normalized;
    return { key: orId, price: livePrice, source: 'openrouter' };
  }

  // 3b. Stripping-based matching — the KEY FIX for local models with parameter suffixes.
  //     Handles cases like "qwen/qwen3-6-35b-a3b-instruct" → strips "-35b-a3b" → matches
  //     against OpenRouter key "qwen3-6". Also tries gemma4 from "gemma4-26b-a3b-qat", etc.
  const stripped = findLivePriceByStripping(normalized);
  if (stripped && (stripped.price.input > 0 || stripped.price.output > 0)) {
    return {
      key: stripped.orId,
      price: stripped.price,
      source: 'openrouter-stripped',
    };
  }

  // 3c. Try alias rules against live prices
  for (const rule of ALIAS_RULES) {
    if (rule.pattern.test(modelId)) {
      const target = rule.target;
      const lp = livePrices.get(target.toLowerCase());
      if (lp && (lp.input > 0 || lp.output > 0)) {
        return { key: target, price: lp, source: 'openrouter' };
      }
    }
  }

  // 4. Fallback embedded DB (word-boundary matching to avoid false positives like 'gpt-4o' matching 'gpt-4o-mini')
  for (const [key, price] of Object.entries(FALLBACK_PRICES)) {
    if (keyMatches(normalized, key)) {
      return { key, price, source: 'fallback' };
    }
  }

  for (const [key, price] of Object.entries(LOCAL_MODEL_DEFAULTS)) {
    if (keyMatches(normalized, key)) {
      return { key, price, source: 'fallback-local' };
    }
  }

  // 4b. Fallback local DB match → also check for online equivalent for savings comparison
  for (const [key, _price] of Object.entries(LOCAL_MODEL_DEFAULTS)) {
    if (keyMatches(normalized, key)) {
      // Found local match — also look up online equivalent for savings comparison
      const online = resolveOnlineEquivalent(modelId);
      return {
        key,
        price: { input: 0, output: 0 },
        source: 'fallback-local',
        comparableOnlinePrice: online,
      };
    }
  }

  // 5. Default: free/local model — check for online equivalent too
  const onlineDefault = resolveOnlineEquivalent(modelId);
  return {
    key: modelId,
    price: { input: 0, output: 0 },
    source: 'local-default',
    comparableOnlinePrice: onlineDefault,
  };
}

/** Check if a fallback key matches a normalized model ID using word-boundary matching.
 *
 *  Avoids false positives like 'gpt-4o' matching 'gpt-4o-mini' by requiring:
 *  - Exact match, or
 *  - Normalized starts with key + "-", or
 *  - Normalized ends with "-" + key, or
 *  - A long word (>3 chars) from the normalized ID is a FULL token of the key,
 *    AND every size-bearing token in the key (e.g. "27b", "a95b") also appears
 *    in the normalized ID — pricing varies by parameter count, so matching on
 *    the family prefix alone (e.g. "qwen3.8" ~ "qwen3.8-27b") is not enough.
 */
function keyMatches(normalized: string, key: string): boolean {
  const keyLower = key.toLowerCase();
  if (
    normalized === keyLower ||
    normalized.startsWith(keyLower + '-') ||
    normalized.endsWith('-' + keyLower)
  ) {
    return true;
  }
  const longWord = normalized.split('-').find((x) => x.length > 3);
  if (!longWord) return false;
  if (!keyLower.split('-').includes(longWord)) return false;
  const normTokens = new Set(normalized.split('-'));
  return keyLower
    .split('-')
    .filter((t) => /\d/.test(t) && /[a-z]/i.test(t))
    .every((t) => normTokens.has(t));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtCost(n: number): string {
  if (n < 0.00001 && n > 0) return `<$0.00001`;
  if (n === 0) return `$0.00000`;
  return `$${n.toFixed(5)}`;
}

function fmtCostCompact(n: number): string {
  if (n < 0.00001 && n > 0) return `<$0.00001`;
  if (n === 0) return `$0.00000`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(5)}`;
}

/** Get a human-readable display name for the current model */
function modelName(modelId: string): string {
  const resolved = resolveModel(modelId);

  // User-configured label takes highest priority
  if (resolved.source === 'user-config') {
    const config = loadUserConfig();
    for (const [key, override] of Object.entries(config)) {
      if (override.label && (key === modelId || key === resolved.key)) {
        return override.label;
      }
    }
  }

  // Use the OpenRouter display name when available from live/fallback resolution
  if (
    (resolved.source === 'openrouter' ||
      resolved.source === 'openrouter-stripped') &&
    modelIdMap.has(normalizeModelName(modelId))
  ) {
    const orDisplay = modelIdMap.get(normalizeModelName(modelId));
    if (orDisplay) return extractModelName(orDisplay);
  }

  // Fall back to extracting a clean name from the raw ID (handles file paths, etc.)
  return extractModelName(modelId);
}

// ─── Color Helpers (ANSI truecolor, like pi-token-speed) ─────────────────────
/** Apply a custom hex color using 24-bit ANSI escape codes. */
function colorHex(text: string, hex: string): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return text;
  const [, rgb] = m;
  const r = parseInt(rgb.slice(0, 2), 16);
  const g = parseInt(rgb.slice(2, 4), 16);
  const b = parseInt(rgb.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

/** Check if a resolved model has pricing (matched → green) or not matched → red). */
function isPricedMatch(resolved: { source: string }): boolean {
  // Matched from OpenRouter, fallback DB, or user-config = has pricing
  return [
    'openrouter',
    'openrouter-stripped',
    'fallback',
    'user-config',
  ].includes(resolved.source);
}

/** Build the model name with color: green if priced match, red if not. */
function coloredModelName(modelId: string): string {
  const resolved = resolveModel(modelId);
  if (!isPricedMatch(resolved))
    return colorHex(extractModelName(modelId), '#ff4444'); // red
  return colorHex(extractModelName(modelId), '#00cc66'); // green
}

// ─── State ──────────────────────────────────────────────────────────────────

let history: CostHistory = { entries: [], version: 1 };
let sessionInputTokens = 0;
let sessionOutputTokens = 0;
let sessionCostTotal = 0;
let currentModelId = '';
let _refreshInterval: ReturnType<typeof setInterval> | null = null;

function loadHistory(ctx: ExtensionContext): void {
  history = { entries: [], version: 1 };

  // First: load from cross-session file (survives restarts)
  const fileEntries = loadHistoryFromFile();
  history.entries.push(...fileEntries);

  // Then: load from current session entries (may include entries not yet flushed to file)
  for (const entry of ctx.sessionManager.getEntries()) {
    // Read delta entries (each is a single CostEntry)
    if (entry.type === 'custom' && entry.customType === 'token-cost-entry') {
      const data = entry.data as CostEntry | undefined;
      if (data) history.entries.push(data);
    }
    // Backward compatibility: also read old format (full history objects)
    if (entry.type === 'custom' && entry.customType === 'token-cost-history') {
      const data = entry.data as CostHistory | undefined;
      if (data?.entries) history.entries.push(...data.entries);
    }
  }
}

// ─── Status Bar Integration (powerline-compatible) ────────────────────────
/** Status key used for powerline footer integration. */
const STATUS_KEY = 'tokenCosts';

let _lastStatusText: string | undefined;

function updateStatus(ctx: ExtensionContext): void {
  // Use module-level state directly — ExtensionContext has no .history prop
  let histInput = 0,
    histOutput = 0,
    histCost = 0;

  for (const e of history.entries) {
    if (e.modelId === currentModelId || (!currentModelId && true)) {
      histInput += e.inputTokens;
      histOutput += e.outputTokens;
      histCost += e.costTotal;
    }
  }

  // Show current-session activity (dynamic) as primary, with cumulative history as backup
  const hasSessionActivity = sessionInputTokens > 0 || sessionOutputTokens > 0;
  const input = hasSessionActivity ? sessionInputTokens : histInput;
  const output = hasSessionActivity ? sessionOutputTokens : histOutput;
  const cost = hasSessionActivity ? sessionCostTotal : histCost;
  const fmt = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}k`
        : `${n}`;

  const modelStr = currentModelId
    ? coloredModelName(currentModelId)
    : colorHex('no-model', '#ff4444');
  const statusText = `↑in: ${fmt(input)} ↓out: ${fmt(output)} ${fmtCostCompact(cost)} · ${modelStr} |`;

  // Only call setStatus when text changed (avoids unnecessary powerline re-renders)
  if (_lastStatusText !== statusText) {
    _lastStatusText = statusText;
    ctx.ui.setStatus(STATUS_KEY, statusText);
  }
}

// ─── Extension Entry Point (ASYNC FACTORY — fetches live pricing first) ──────

export default async function (pi: ExtensionAPI) {
  console.log('[token-costs] Loading token cost tracking extension...');

  // Fetch live pricing from OpenRouter API (cached for 24h, falls back to embedded defaults)
  const fetched = await fetchLivePricing();
  if (!fetched) loadFallbackPricing();

  console.log(`[token-costs] Active model count: ${livePrices.size}`);

  // ─── Session Events ──────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    loadHistory(ctx);
    sessionInputTokens = 0;
    sessionOutputTokens = 0;
    sessionCostTotal = 0;

    if (ctx.model?.id) {
      currentModelId = ctx.model.id;
      const resolved = resolveModel(currentModelId);
      const name = modelName(currentModelId);
      if (resolved.price.input > 0 || resolved.price.output > 0) {
        ctx.ui.notify(
          `Token tracking: ${name} — $
					${resolved.price.input.toFixed(5)} input /
					$${resolved.price.output.toFixed(5)} output per M tokens
					(${resolved.source})`,
          'info',
        );
      } else {
        ctx.ui.notify(`Token tracking: ${name} (local/free model)`, 'info');
      }

      // New-release gap: the cached OpenRouter list can lag by up to 24h.
      // If this model matched nothing locally, fetch its price individually.
      if (resolved.source === 'local-default') {
        const mid = currentModelId;
        fetchPriceForModel(mid, (_orId, price) => {
          try {
            ctx.ui.notify(
              `Pricing found for ${name}: $${price.input.toFixed(5)} / $${price.output.toFixed(5)} per M tokens (OpenRouter)`,
              'info',
            );
            updateStatus(ctx);
          } catch {
            /* session may have ended */
          }
        }).catch(() => {});
      }
    }

    // Set up periodic status updates in powerline footer (every 1.5s)
    if (ctx.mode === 'tui') {
      setInterval(() => updateStatus(ctx), 1500);
      updateStatus(ctx); // Initial render
    }

    // Refresh pricing every 24h while session is active
    if (_refreshInterval) clearInterval(_refreshInterval);
    _refreshInterval = setInterval(async () => {
      await fetchLivePricing();
      console.log('[token-costs] Pricing refreshed');
    }, CACHE_TTL_MS);
  });

  pi.on('session_shutdown', async (_event, _ctx) => {
    if (_refreshInterval) {
      clearInterval(_refreshInterval);
      _refreshInterval = null;
    }
    // Clear powerline status on shutdown
    _ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on('model_select', async (event, ctx) => {
    currentModelId = event.model.id;
    // Same new-release gap handling when switching to an unknown model mid-session.
    if (resolveModel(event.model.id).source === 'local-default') {
      const mid = event.model.id;
      fetchPriceForModel(mid, () => {
        try {
          updateStatus(ctx);
        } catch {
          /* ignore */
        }
      }).catch(() => {});
    }
  });

  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant') return;
    const msg = event.message as AssistantMessage;
    if (!msg.usage || (!msg.usage.input && !msg.usage.output)) return;

    const modelId = ctx.model?.id || 'unknown';
    const inputTokens = msg.usage.input;
    const outputTokens = msg.usage.output;
    const resolved = resolveModel(modelId);

    let costInput: number,
      costOutput: number,
      costCacheRead: number,
      costCacheWrite: number;
    // Use provider-reported costs when available AND non-zero.
    // Local models often report { input: 0, output: 0 } in the usage.cost
    // fields even though resolved.price has valid pricing — in that case,
    // fall back to calculating from token counts × resolved price.
    const providerHasRealCosts =
      msg.usage.cost.input !== undefined &&
      msg.usage.cost.output !== undefined &&
      (msg.usage.cost.input > 0 || msg.usage.cost.output > 0);

    if (providerHasRealCosts) {
      costInput = msg.usage.cost.input;
      costOutput = msg.usage.cost.output;
      costCacheRead = msg.usage.cost.cacheRead || 0;
      costCacheWrite = msg.usage.cost.cacheWrite || 0;
    } else if (resolved.price.input > 0 || resolved.price.output > 0) {
      // We have valid pricing but provider gave zeros — calculate ourselves
      costInput = (inputTokens / 1_000_000) * resolved.price.input;
      costOutput = (outputTokens / 1_000_000) * resolved.price.output;
      costCacheRead = 0;
      costCacheWrite = 0;
    } else {
      // Truly free/local model — everything is zero
      costInput = 0;
      costOutput = 0;
      costCacheRead = 0;
      costCacheWrite = 0;
    }

    const providerTotal = msg.usage.cost?.total ?? -1;
    const costTotal =
      providerHasRealCosts && providerTotal > 0
        ? providerTotal
        : costInput + costOutput;

    const entry: CostEntry = {
      timestamp: Date.now(),
      modelId,
      inputTokens,
      outputTokens,
      costInput,
      costOutput,
      costCacheRead,
      costCacheWrite,
      costTotal,
    };
    history.entries.push(entry);
    sessionInputTokens += inputTokens;
    sessionOutputTokens += outputTokens;
    sessionCostTotal += costTotal;

    // Update powerline status immediately after recording new token data
    updateStatus(ctx);

    // Append only the delta entry to avoid unbounded growth of session log.
    // Previously appended the entire history object every turn, causing
    // JSON.stringify to fail with "Invalid string length" on long sessions.
    pi.appendEntry('token-cost-entry', entry);

    // Persist to cross-session file
    appendToHistoryFile(entry);
  });

  // ─── Commands ──────────────────────────────────────────────────────

  pi.registerCommand('token-stats', {
    description: 'Show token usage and cost statistics for current session',
    handler: async (_args, ctx) => {
      let histInput = 0,
        histOutput = 0,
        histCost = 0;
      for (const e of ctx.sessionManager.getBranch()) {
        if (e.type === 'message' && e.message.role === 'assistant') {
          const msg = e.message as AssistantMessage;
          if (msg.usage) {
            histInput += msg.usage.input;
            histOutput += msg.usage.output;
            histCost += msg.usage.cost.total || 0;
          }
        }
      }

      const finalInput = histInput || sessionInputTokens;
      const finalOutput = histOutput || sessionOutputTokens;
      const finalCost = histCost || sessionCostTotal;

      if (finalInput === 0 && finalOutput === 0) {
        ctx.ui.notify('No token usage recorded yet in this session.', 'info');
        return;
      }

      const resolved = currentModelId ? resolveModel(currentModelId) : null;
      const modelLabel = modelName(currentModelId || 'unknown');

      const lines = [
        `Session: ${modelLabel}`,
        `Input:  ${fmtTokens(finalInput)} tokens`,
        `Output: ${fmtTokens(finalOutput)} tokens`,
        `Total:  ${fmtTokens(finalInput + finalOutput)} tokens`,
        `Est. Cost: ${fmtCost(finalCost)}`,
      ];

      if (
        resolved &&
        ((resolved.price && resolved.price.input > 0) ||
          (resolved.price && resolved.price.output > 0))
      ) {
        lines.push(
          `Price: $${resolved.price!.input.toFixed(5)} / $${resolved.price!.output.toFixed(5)} per M tokens`,
        );
      } else if (resolved) {
        lines.push('Price: local/free model');
      }

      const modelTurns: Record<
        string,
        { input: number; output: number; cost: number }
      > = {};
      for (const e of history.entries) {
        if (!modelTurns[e.modelId])
          modelTurns[e.modelId] = { input: 0, output: 0, cost: 0 };
        modelTurns[e.modelId].input += e.inputTokens;
        modelTurns[e.modelId].output += e.outputTokens;
        modelTurns[e.modelId].cost += e.costTotal;
      }

      if (Object.keys(modelTurns).length > 1) {
        lines.push('', 'By model:');
        for (const [model, data] of Object.entries(modelTurns)) {
          lines.push(
            `  ${modelName(model)}: ${fmtTokens(data.input + data.output)} tokens · ${fmtCost(data.cost)}`,
          );
        }
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('token-history', {
    description:
      'Show token usage history across all sessions (last 50 entries)',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('/token-history requires TUI mode', 'error');
        return;
      }

      const entries = history.entries.slice(-50).toReversed();
      if (entries.length === 0) {
        ctx.ui.notify('No token usage history yet.', 'info');
        return;
      }

      let totalInput = 0,
        totalOutput = 0,
        totalCost = 0;
      for (const e of entries) {
        totalInput += e.inputTokens;
        totalOutput += e.outputTokens;
        totalCost += e.costTotal;
      }

      const byModel: Record<
        string,
        { count: number; input: number; output: number; cost: number }
      > = {};
      for (const e of entries) {
        if (!byModel[e.modelId])
          byModel[e.modelId] = { count: 0, input: 0, output: 0, cost: 0 };
        byModel[e.modelId].count++;
        byModel[e.modelId].input += e.inputTokens;
        byModel[e.modelId].output += e.outputTokens;
        byModel[e.modelId].cost += e.costTotal;
      }

      const lines = [
        `Token Usage History (${entries.length} messages)`,
        `─────────────────────────────`,
        `Total Input:  ${fmtTokens(totalInput)} tokens`,
        `Total Output: ${fmtTokens(totalOutput)} tokens`,
        `Est. Total Cost: ${fmtCost(totalCost)}`,
        '',
        'By Model:',
      ];

      for (const [modelId, data] of Object.entries(byModel).sort(
        (a, b) => b[1].cost - a[1].cost,
      )) {
        const name = modelName(modelId);
        const resolved = resolveModel(modelId);
        lines.push(`  ${name}`);
        lines.push(
          `    Messages: ${data.count} · Input: ${fmtTokens(data.input)} · Output: ${fmtTokens(data.output)}`,
        );
        if (resolved.price.input > 0 || resolved.price.output > 0) {
          lines.push(
            `    Price: $${resolved.price.input.toFixed(5)}/$${resolved.price.output.toFixed(5)} per M tokens (${resolved.source})`,
          );
        } else {
          lines.push(`    Price: local/free (${resolved.source})`);
        }
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('token-clear', {
    description: 'Clear all persisted token usage history',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('/token-clear requires TUI mode', 'error');
        return;
      }

      const ok = await ctx.ui.confirm(
        'Clear History',
        `Delete ${history.entries.length} token cost entries? This cannot be undone.`,
      );
      if (!ok) {
        ctx.ui.notify('History not cleared.', 'info');
        return;
      }

      const count = history.entries.length;
      history = { entries: [], version: 1 };
      sessionInputTokens = 0;
      sessionOutputTokens = 0;
      sessionCostTotal = 0;

      ctx.ui.notify(`Cleared ${count} history entries.`, 'info');
    },
  });

  pi.registerCommand('token-price', {
    description: 'Show pricing info for a model, or set a price override',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const arg = _args?.trim();

      if (arg && arg.startsWith('--set')) {
        const parts = arg.slice(6).trim().split(/\s+/);
        if (parts.length < 3) {
          ctx.ui.notify(
            'Usage: /token-price --set <model-id> <input-per-M> <output-per-M>\n' +
              'Example: /token-price --set ollama/qwen2.5-coder:32b 0.0 0.0',
            'info',
          );
          return;
        }

        const modelId = parts[0];
        const inputPrice = parseFloat(parts[1]);
        const outputPrice = parseFloat(parts[2]);
        if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) {
          ctx.ui.notify('Input and output prices must be numbers.', 'error');
          return;
        }

        const existing = loadUserConfig();
        existing[modelId] = { input: inputPrice, output: outputPrice };
        writeFileSync(
          getConfigPath(),
          JSON.stringify(existing, null, 2),
          'utf8',
        );

        ctx.ui.notify(
          `Set price override for "${modelId}": $${inputPrice.toFixed(5)} / $${outputPrice.toFixed(5)} per M tokens.\nConfig: ${getConfigPath()}`,
          'info',
        );
        return;
      }

      const target = arg || currentModelId;
      if (!target) {
        ctx.ui.notify(
          'Usage:\n' +
            '  /token-price                  — show current model pricing\n' +
            '  /token-price <model-id>       — show pricing for specific model\n' +
            '  /token-price --set <id> $in $out — set price override',
          'info',
        );
        return;
      }

      const resolved = resolveModel(target);
      const name = modelName(target);
      const config = loadUserConfig();
      let userOverride: PriceOverride | undefined;
      for (const [key, val] of Object.entries(config)) {
        if (key === target || key === resolved.key) {
          userOverride = val;
          break;
        }
      }

      const lines = [
        `Model: ${name}`,
        `Raw ID:  ${target}`,
        `Resolved to: ${resolved.key} (${resolved.source})`,
        `Price: $${resolved.price.input.toFixed(5)} input / $${resolved.price.output.toFixed(5)} output per M tokens`,
      ];

      if (userOverride) {
        lines.push(
          `User override: $${userOverride.input?.toFixed(5) ?? 'N/A'} / $${userOverride.output?.toFixed(5) ?? 'N/A'}`,
        );
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('token-matrix', {
    description:
      'Generate a GitHub-style contribution matrix showing daily token/cost usage and open it in your browser',
    handler: async (_args, ctx) => {
      if (history.entries.length === 0) {
        ctx.ui.notify('No token usage history to display.', 'info');
        return;
      }

      // Parse args: --weeks N or --months N (default: 12 weeks)
      const arg = _args?.trim() || '';
      let weeks = 12;
      let months = 0;
      const weeksMatch = arg.match(/--weeks\s+(\d+)/);
      const monthsMatch = arg.match(/--months\s+(\d+)/);
      if (weeksMatch) weeks = parseInt(weeksMatch[1], 10);
      if (monthsMatch) {
        months = parseInt(monthsMatch[1], 10);
        weeks = 0; // months overrides weeks
      }

      // Calculate the date range
      const startDate =
        months > 0
          ? Date.now() - months * 30 * 24 * 60 * 60 * 1000
          : Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;

      // Helper: get local date string (YYYY-MM-DD) from a Date object
      const localDateStr = (d: Date): string => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
      };

      // Aggregate entries by calendar day
      const dayMap = new Map<string, DayData>();
      for (const entry of history.entries) {
        if (entry.timestamp < startDate) continue;
        const date = new Date(entry.timestamp);
        const dateKey = localDateStr(date);

        if (!dayMap.has(dateKey)) {
          dayMap.set(dateKey, {
            date: dateKey,
            dayOfWeek: date.getDay(),
            dayOfMonth: date.getDate(),
            month: date.getMonth(),
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costTotal: 0,
            byModel: {},
          });
        }

        const day = dayMap.get(dateKey)!;
        day.inputTokens += entry.inputTokens;
        day.outputTokens += entry.outputTokens;
        day.totalTokens = day.inputTokens + day.outputTokens;
        day.costTotal += entry.costTotal;

        // Per-model breakdown
        if (!day.byModel[entry.modelId]) {
          day.byModel[entry.modelId] = {
            inputTokens: 0,
            outputTokens: 0,
            costTotal: 0,
          };
        }
        day.byModel[entry.modelId].inputTokens += entry.inputTokens;
        day.byModel[entry.modelId].outputTokens += entry.outputTokens;
        day.byModel[entry.modelId].costTotal += entry.costTotal;
      }

      // Sort by date
      const dayData = Array.from(dayMap.values()).sort((a, b) =>
        a.date.localeCompare(b.date),
      );

      if (dayData.length === 0) {
        const rangeLabel =
          months > 0
            ? `${months} month${months > 1 ? 's' : ''}`
            : `${weeks} week${weeks > 1 ? 's' : ''}`;
        ctx.ui.notify(`No token usage data in the last ${rangeLabel}.`, 'info');
        return;
      }

      // Generate title
      const rangeLabel =
        months > 0
          ? `Last ${months} month${months > 1 ? 's' : ''}`
          : `Last ${weeks} week${weeks > 1 ? 's' : ''}`;
      const title = `Token Usage — ${rangeLabel}`;

      // Generate HTML
      const html = generateMatrixHtml(dayData, title);

      // Write to a temp file and open in browser
      const tempDir = process.env.TEMP || process.env.TMP || '/tmp';
      const htmlPath = join(tempDir, 'pi-token-matrix.html');
      writeFileSync(htmlPath, html, 'utf8');

      // Open in default browser (cross-platform)
      try {
        if (process.platform === 'win32') {
          execSync(`start "" "file:///${htmlPath}"`, { stdio: 'ignore' });
        } else if (process.platform === 'darwin') {
          execSync(`open "${htmlPath}"`, { stdio: 'ignore' });
        } else {
          execSync(`xdg-open "${htmlPath}"`, { stdio: 'ignore' });
        }
        ctx.ui.notify(
          `Opened token usage matrix in browser. (${dayData.length} days, ${htmlPath})`,
          'info',
        );
      } catch (err) {
        ctx.ui.notify(
          `Matrix saved to ${htmlPath} (failed to open browser)`,
          'info',
        );
      }
    },
  });

  // ─── Tool: record_token_usage (for LLM to call explicitly if needed) ──

  pi.registerTool({
    name: 'record_token_usage',
    label: 'Record Tokens',
    description: 'Manually record token usage for a model turn.',
    parameters: Type.Object({
      inputTokens: Type.Number({ description: 'Number of input tokens' }),
      outputTokens: Type.Number({ description: 'Number of output tokens' }),
      modelId: Type.Optional(
        Type.String({ description: 'Model ID (defaults to current model)' }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const modelId = params.modelId || currentModelId;
      const resolved = resolveModel(modelId);

      const entry: CostEntry = {
        timestamp: Date.now(),
        modelId,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        costInput: (params.inputTokens / 1_000_000) * resolved.price.input,
        costOutput: (params.outputTokens / 1_000_000) * resolved.price.output,
        costCacheRead: 0,
        costCacheWrite: 0,
        costTotal:
          ((params.inputTokens + params.outputTokens) / 1_000_000) *
          (resolved.price.output || resolved.price.input),
      };

      history.entries.push(entry);
      sessionInputTokens += params.inputTokens;
      sessionOutputTokens += params.outputTokens;
      sessionCostTotal += entry.costTotal;
      pi.appendEntry('token-cost-entry', entry);
      appendToHistoryFile(entry);

      return {
        content: [
          {
            type: 'text',
            text:
              `Recorded ${fmtTokens(params.inputTokens)} input + ${fmtTokens(params.outputTokens)} output tokens for ${modelName(modelId)}. ` +
              `Est. cost: ${fmtCost(entry.costTotal)}`,
          },
        ],
        details: { modelId, entry },
      };
    },
  });
}
