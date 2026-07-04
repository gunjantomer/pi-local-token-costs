# Token Cost Tracking Extension

Tracks token usage and estimated costs for every model in every Pi session. Shows live costs in the powerline footer, maintains cross-session history, and always uses the cheapest available provider pricing from OpenRouter.

**Key features:**

- Live pricing from 30+ providers (cheapest rate automatically selected)
- Accurate local model matching via dot-preserved keys, GGUF stripping, and param-count-aware strategies
- Savings comparison: see what running locally costs vs. online equivalents
- Cross-session history with per-model breakdowns
- Offline fallback with ~60 cloud models + Qwen family pricing

## Changelog

### 2026-07-04 — Added dot-preserved fallback entries for Qwen3.6 & Qwen3.5; improved status bar labels

**Problem**: `Qwen3.6-27B` normalized to `qwen3.6-27b` (dot preserved) but the fallback DB only had `qwen3-6-27b` (dashes). The stripping pipeline couldn't bridge the dot/dash gap, so the model fell through to the generic `qwen3` family key (`$0.09/$1.1` per M) instead of the correct `qwen3-6-27b` price (`$0.285/$2.4` per M). With >1M output tokens, this showed `$0.39` instead of the correct ~`$2.66`.

**Fixes applied:**

1. **Added missing dot-preserved fallback entries** for Qwen3.6 and Qwen3.5 families:
   - Qwen3.6: `qwen3.6-27b`, `qwen3.6-flash`, `qwen3.6-plus`, `qwen3.6-max-preview`
   - Qwen3.5: `qwen3.5-9b`, `qwen3.5-14b`, `qwen3.5-plus-02-15`, `qwen3.5-plus-20260420`

2. **Added "in:" / "out:" labels** to the powerline status bar for clarity:
   - Before: `↑1.11M ↓33.2k $0.39 · Qwen3.6-27B`
   - After: `↑in: 1.11M ↓out: 33.2k $0.39 · Qwen3.6-27B |`

### 2026-07-03 — Expanded Qwen fallback pricing, LM Studio direct matching, cost precision fixes

**Problem**: Local Qwen models on LM Studio/Ollama were not getting accurate online-equivalent pricing in the fallback DB. The extension also showed costs at only 4 decimal places and had a bug where provider-reported zero costs were used even when `resolveModel()` found valid pricing.

**Fixes applied:**

1. **Expanded Qwen fallback database with 50+ specific entries** from OpenRouter's cheapest providers:
   - Qwen2.x (7B, 32B Coder, 72B) — $0.04–$0.66/M input
   - Qwen3.x MoE A3B (8B–80B) — $0.05–$0.15/M input
   - Qwen3.x dense (8B–235B) — $0.08–$0.46/M input
   - Qwen3-VL vision models, flash/fast variants, Plus/Max tiers

2. **Dot-preserved fallback keys** for LM Studio/Ollama model IDs:
   Added direct entries like `"qwen3.6-35b-a3b"` and `"qwen3.6-35b-a3b-q4-k-m"` so local models match without needing stripping.

3. **Enhanced `loadFallbackPricing()`** registers dot-preserved variants (e.g., `"qwen3-6-35b-a3b"` → also `"qwen3.6-35b-a3b"`) and family-only keys (`"qwen2"`, `"qwen3"`) for broader fallback matching.

4. **Fixed cost calculation bug**: When local models report `{cost: {input: 0, output: 0}}` in `usage.cost` but `resolveModel()` found valid pricing, the extension now calculates from token counts × resolved price instead of using zeros.

5. **Cost precision increased** to 5 decimal places everywhere (was 2–4).

### 2026-07-03 — Fixed: Local model pricing, param-count matching, and savings comparison

**Problem**: Three critical issues prevented accurate cost tracking for local models:

1. **Dots in version numbers were being stripped**, breaking OpenRouter key matching.
   - OpenRouter uses dots in model IDs like `qwen/qwen3.6-35b-a3b-instruct`
   - Normalization was converting `.` → `-`, producing `qwen3-6` instead of `qwen3.6`
   - This caused all Qwen3.6 models to fall through to generic family pricing ($0.33/M) instead of the correct per-parameter price ($0.14/M for 35B-A3B)

2. **Stripping strategies discarded param counts too aggressively**.
   - When local model IDs like `Qwen/Qwen3.6-35B-A3B-Instruct` didn't match directly, the stripping pipeline would remove `-instruct` AND `-35b-a3b`, falling back to generic pricing

3. **No savings comparison for local models**.
   - Local models resolved to `$0/$0` with no indication of the online equivalent cost

**Fixes applied in `token-costs.ts`:**

1. **Dot preservation in version numbers** (`normalizeModelId()` and `normalizeModelName()`):

   ```ts
   // OLD: collapse all separators including dots
   return id.toLowerCase().replace(/[\s._/-]+/g, "-");
   
   // NEW: preserve dots (version numbers), collapse other separators
   return id.toLowerCase().replace(/[\s_/-]+/g, "-");
   ```

2. **Param-count-aware stripping strategies** (`findLivePriceByStripping()`):

   ```ts
   // Strategy B: Strip semantic suffixes (-instruct, -chat, etc.) while KEEPING param counts & variant tags
   result = normalized.replace(/-(?:instruct|chat|turbo|h|gq|i1)(?:-[0-9]+)?$/i, "");

   // Strategy C: Strip variant tags (-a3b, -qat) while KEEPING param count
   result = normalized.replace(/-\d+[bmBMk]+(?:-(?:a3b|qat))+(?:-[a-z0-9]+)*$/, "");

   // Strategy D: Strip variant tags + semantic suffixes, KEEPING param count
   result = normalized.replace(/-\d+[bmBMk]+(?:-(?:a3b|qat))+(?:-[a-z0-9]+)*(?::|-)?(instruct|chat|turbo|h|gq|i1)?$/i, "");

   // Strategy E: Strip param count + variants together (fallback)
   result = normalized.replace(/-\d+[bmBMk]+(?:-(?:a3b|qat))+(?:-[a-z0-9]+)*$/, "");
   ```

3. **Local model savings comparison** (`resolveModel()`): Added `comparableOnlinePrice` field for local/free models. When a model resolves to `$0/$0`, this shows what running it through an online provider would cost.

### 2026-07-03 — Fixed: Footer no longer shows costs

**Problem**: The footer was never displaying token counts or cost estimates, showing `↑0 ↓0 $0` for every model.

**Root cause**: The extension used the wrong API (`setFooter()`) which conflicted with the [pi-powerline-footer](https://github.com/gsanhueza/pi-powerline-footer) extension.

**Fix**: Replaced `setFooter()` with `setStatus("tokenCosts", text)` so powerline automatically renders costs in its `extension_statuses` segment, just like [pi-token-speed](https://github.com/gsanhueza/pi-token-speed) displays TPS.

### 2026-07-03 — Fixed: GGUF quantization tags break local model pricing

**Problem**: Local models with GGUF quantized weights (e.g., `Q4_K_M`, `Q8_0`) resolved to `$0` because the normalization pipeline included quantization suffixes in the lookup key.

**Fix**: Added GGUF quantization tag stripping (`findLivePriceByStripping()` Strategy A) and direct dot-preserved fallback keys for common quantized filenames like `"qwen3.6-35b-a3b-q4-k-m"`.

## Installation

The extension is auto-discovered by pi because it lives in `~/.pi/agent/extensions/token-costs.ts`. No configuration needed — just restart pi or run `/reload` to activate.

## Features

### Live Footer Display (Powerline)

The powerline footer automatically shows real-time token counts and estimated cost:

```
↑in: 142k ↓out: 28k $0.20000 · Qwen3.6-35B-A3B |
```

- `↑in:` = input tokens consumed this session (dynamic, updates while streaming)
- `↓out:` = output tokens generated this session (dynamic)
- `$X.XXXXX` = cumulative estimated cost (cheapest provider pricing, 5 decimal places)
- `·` separates cost from model name
- Model name shown with color (green if priced match, red if not)
- `|` trailing separator marks end of token-costs status segment

### Cross-Session History

Every assistant message's token usage is persisted across sessions. Run `/token-history` to see the last 50 messages grouped by model with per-model costs.

### Cheapest Provider Pricing

At startup, the extension fetches live pricing from [OpenRouter's API](https://openrouter.ai/api/v1/models), which aggregates rates from **30+ providers** (Anthropic, OpenAI, Together AI, Groq, Google Vertex, Mistral, Fireworks, DeepInfra, Anyscale, Perplexity, etc.). For each model, it automatically selects the provider with the lowest input and output prices.

Example: Llama 3.3 70B Instruct is priced at **$0.10/$0.32 per M tokens** on OpenRouter (cheapest route), even though Together AI charges $0.20/$0.40 for the same model. The extension always uses the cheaper rate.

### Offline Fallback

If the OpenRouter API is unreachable, the extension falls back to an embedded database of **60+ cloud models** including comprehensive Qwen family pricing and local model defaults. Local/Ollama models with valid fallback entries show their online-equivalent cost; unknown models default to `$0` (free).

### Local Model Savings Comparison

For local/free models, the extension shows what running them through an online provider would cost — so you can gauge your savings.

**How it works:**

- When a model resolves to `$0/$0` (local/free), `comparableOnlinePrice` is populated via alias rules
- This finds the closest cloud equivalent and shows its cheapest OpenRouter rate
- Users can see: "Running Qwen3.6-35B-A3B locally costs $0, vs $0.14/M input online"

**Example:**

```
Model: Qwen/Qwen3.6-35B-A3B-Instruct (Ollama)
Price: $0.00000 / $0.00000 per M tokens (fallback-local)
Online equivalent: $0.14000 / $1.00000 per M tokens
Savings: 100% (or ~$X.XXXXX saved this session)
```

## Commands

| Command | Description |
|---------|-------------|
| `/token-stats` | Show current session's token usage and cost breakdown by model |
| `/token-history` | Show cross-session history of the last 50 messages, grouped by model with pricing source |
| `/token-clear` | Clear all persisted token usage history (with confirmation) |
| `/token-price <model-id>` | Show how a specific model is resolved and priced — includes `source` field (`openrouter`, `fallback`, `user-config`, etc.) and `comparableOnlinePrice` for local models |
| `/token-price --set <id> $in $out` | Set a custom price override for any model ID |

### Examples

```bash
# Check pricing for your current model
/token-price

# Look up pricing for a specific model
/token-price ollama/qwen2.5-coder:32b

# Override pricing for a local model
/token-price --set ollama/qwen2.5-coder:32b 0.0 0.0

# Show session stats
/token-stats
```

## Configuration File

### `~/.pi/agent/token-costs.json` — User Price Overrides

Set custom prices for any model. This takes **highest priority** over all other pricing sources (live API, fallback DB, aliases).

```jsonc
{
  // Override a specific provider-prefixed model ID
  "ollama/qwen2.5-coder:32b": {
    "input": 0.0,      // $ per 1M tokens for input
    "output": 0.0,     // $ per 1M tokens for output
    "label": "Qwen2.5-Coder-32B (Ollama)"  // Optional: display name in UI
  },

  // Override using a normalized model ID
  "qwen2.5-coder": {
    "input": 0.0,
    "output": 0.0,
    "label": "Local Qwen Coder"
  }
}
```

### `~/.pi/agent/token-costs-cache.json` — Live Pricing Cache (auto-managed)

The extension caches OpenRouter API responses for **24 hours** to avoid redundant network calls. This file is auto-created and updated — do not edit manually. To force a refresh, delete the cache file or wait 24 hours.

## How Model Matching Works

When tracking usage, the extension maps whatever model ID pi reports (e.g., `ollama/qwen2.5-coder:32b`, `Qwen/Qwen3.6-35B-A3B-Instruct`, full LM Studio file paths) to a pricing entry using this **priority chain**:

```
1. User config override (exact model ID match)      → ~/.pi/agent/token-costs.json
2. User config override (normalized model ID)        → normalized = lowercase, no prefixes
3. Live OpenRouter API (cheapest provider rate)      → fetched at startup + refreshed every 24h
4. Alias rules (regex patterns for common naming)    → handles Ollama, vLLM, LM Studio conventions
5. Embedded fallback DB (~60 cloud models + Qwen family) → works offline for known models
6. Local model defaults ($0/$0)                      → unknown models assumed free/local
```

### Normalization

Model IDs are normalized by:

1. Stripping provider prefixes (`openai/`, `ollama/`, `google/`, etc.)
2. Stripping file paths and extensions (`.gguf`, `.safetensors`, `.bin`) for LM Studio models
3. Removing version suffixes (`:free`, `-20250307`, `:latest`)
4. Removing HuggingFace org prefixes (`Qwen/`, `meta-llama/`)
5. Lowercasing and collapsing separators — **BUT preserving dots in version numbers**

OpenRouter keys use dots for model versions (e.g., `qwen/qwen3.6-35b-a3b-instruct`). The extension preserves these dots to ensure exact matching against live API responses, and also registers dash-preserved variants (`"qwen3-6"` → `"qwen3.6"`) so both formats match.

Example transformations:

| Raw ID | Normalized | Resolved To |
|--------|-----------|-------------|
| `Qwen/Qwen3.6-35B-A3B-Instruct` | `qwen3.6-35b-a3b-instruct` | Direct fallback → $0.14/M input (fallback) |
| `A:\lmstudio-models\...\Qwen3.6-35B-A3B-Q4_K_M.gguf` | `qwen3.6-35b-a3b-q4-k-m` | Dot-preserved fallback → $0.14/M input (fallback) |
| `ollama/qwen2.5-coder:32b` | `qwen2.5-coder:32b` | Alias rule → Qwen2.5 Coder ($0.66/$1.00 per M tokens, fallback) |
| `gemma4-26B-A3B-QAT` | `gemma4-26b-a3b-qat` | Stripping (-a3b-qat) → family match → `gemma4` (openrouter-stripped) |

### Stripping-Based Matching

When a normalized model ID doesn't directly match any entry, the extension tries **progressive stripping strategies** that preserve param counts through multiple levels:

1. **GGUF quantization tag removal** — `qwen3.6-35b-a3b-q4-k-m` → `qwen3.6-35b-a3b`
2. **Strip semantic suffixes, KEEPING params & variants** — `qwen3.6-35b-a3b-instruct` → `qwen3.6-35b-a3b`
3. **Strip variant tags (-a3b, -qat), KEEPING param count** — `qwen3.6-35b-a3b` → `qwen3.6`
4. **Strip variant tags + semantic suffixes, KEEPING param count** — `qwen3.6-35b-a3b-instruct` → `qwen3.6`
5. **Strip param count + variants together (fallback)** — `qwen3.6-35b-a3b` → `qwen3.6`
6. **Remove org-prefix duplication** — `qwen-qwen3-6` → `qwen3-6`
7. **Try model family name** — `gemma4-a3b-qat` → `gemma4` (family prefix)

For a local model like `Qwen/Qwen3.6-35B-A3B-Instruct`:

```
Normalized: qwen3.6-35b-a3b-instruct
Step 1: Direct match in fallback DB? → YES ✓ matches "qwen3.6-35b-a3b-instruct" at $0.14/M input
Result: Uses embedded fallback price (works offline)
```

For a quantized LM Studio model like `Qwen3.6-35B-A3B-Q4_K_M`:

```
Normalized: qwen3.6-35b-a3b-q4-k-m
Step 1: Direct match in dot-preserved fallback DB? → YES ✓ matches "qwen3.6-35b-a3b-q4-k-m" at $0.14/M input
Result: Uses embedded fallback price (works offline)

(If no direct key existed, Strategy A would strip GGUF tags to "qwen3.6-35b-a3b", which also matches.)
```

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Startup (async factory)                                     │
│                                                              │
│  1. Fetch https://openrouter.ai/api/v1/models               │
│     ├─ Use cache if <24h old                                 │
│     └─ Save to token-costs-cache.json                       │
│                                                              │
│  2. If fetch fails → load embedded fallback DB              │
│     └─ Registers dash + dot-preserved variants for Qwen     │
│        and family-only keys ("qwen2", "qwen3")              │
│                                                              │
│  3. Build livePrices Map: normalized_name → {input, output} │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Per Session                                                 │
│                                                              │
│  session_start  → load persisted history                    │
│                  start powerline status polling (1.5s)      │
│                  start 24h refresh interval                 │
│                                                              │
│  message_end    → recordMessage()                           │
│                    ├─ resolveModel(modelId) ← pricing lookup │
│                    └─ appendEntry("token-cost-history")      │
│                                                              │
│  model_select   → update currentModelId                     │
│                                                              │
│  session_shutdown → stop refresh interval                   │
└─────────────────────────────────────────────────────────────┘
```

### Pricing Resolution Pipeline

```
resolveModel(modelId)
  │
  ├─ loadUserConfig()
  │   └─ Check exact match in token-costs.json          ← HIGHEST PRIORITY
  │
  ├─ normalizeModelId(modelId)
  │   └─ Check normalized match in token-costs.json
  │
  ├─ livePrices.get(normalized)
  │   └─ Live OpenRouter API price (cheapest provider)  ← PRIMARY SOURCE
  │
  ├─ findLivePriceByStripping(normalized)
  │   ├─ GGUF quantization tag removal                  ← Strategy A
  │   ├─ Strip semantic suffixes, KEEPING params        ← Strategy B
  │   ├─ Strip variant tags (-a3b), KEEPING param count ← Strategy C
  │   ├─ Strip variant + semantic, KEEPING param count  ← Strategy D
  │   ├─ Strip param + variants together (fallback)     ← Strategy E
  │   └─ Family name fallback                           ← Strategy F
  │
  ├─ ALIAS_RULES.forEach(rule)
  │   └─ Regex match → check live prices for target     ← Ollama/vLLM support
  │
  ├─ FALLBACK_PRICES lookup                             ← Works offline (~60 models)
  │
  ├─ LOCAL_MODEL_DEFAULTS lookup                        ← Free local models
  │   └─ Also resolve comparableOnlinePrice             ← Savings comparison
  │
  └─ Return { input: 0, output: 0 }                    ← Unknown = free by default
      │
      └─ For local/free models: comparableOnlinePrice shows online equivalent cost
```

### State Persistence

Token history is stored via `pi.appendEntry("token-cost-history", history)`, which persists it in the session file. This means:

- History survives **session restarts** (reload, crash)
- History survives **session forks/clones** (correct state for each branch point)
- History from **previous sessions** is loaded on `session_start` by scanning all entries

### Refresh Strategy

| Event | Action |
|-------|--------|
| Startup | Fetch OpenRouter API → save to cache file |
| Every 24h during active session | Re-fetch and update live prices |
| Cache TTL expired (>24h old) | Re-fetch on next startup |
| Network failure | Log warning, use embedded fallback DB |

## Troubleshooting

### "Using cached pricing data" in console

This is normal — the extension caches OpenRouter API responses for 24 hours. To force a refresh:

```bash
rm ~/.pi/agent/token-costs-cache.json   # Delete cache file
pi --reload                               # Restart pi
```

### Wrong price shown for a model

1. Check what source the model resolved to:

   ```bash
   /token-price <your-model-id>
   ```

2. If it shows `fallback-local` or `local-default`, add an explicit override:

   ```bash
   /token-price --set ollama/your-model 0.0 0.0
   ```

### Extension not showing in footer

Make sure the extension file is at `~/.pi/agent/extensions/token-costs.ts` and restart pi or run `/reload`. The powerline footer reads extension statuses via its `extension_statuses` segment — ensure [pi-powerline-footer](https://github.com/gsanhueza/pi-powerline-footer) is active.

### Checking savings for local models

To see what you're saving by running a local model vs. online:

```bash
/token-price ollama/qwen3.6-35b-a3b
```

Output includes `comparableOnlinePrice` showing the cheapest cloud equivalent rate, so you can calculate your savings.

### Offline mode

The extension works fully offline using its embedded fallback database (~60 cloud models + local model defaults). The only feature that requires network access is live price fetching — everything else (tracking, history, commands) works without it.
