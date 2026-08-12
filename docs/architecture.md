# Architecture

## Data Flow

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
│                    ├─ appendEntry("token-cost-entry")         │
│                    └─ appendToHistoryFile(entry)              │
│                                                              │
│  model_select   → update currentModelId                     │
│                                                              │
│  session_shutdown → stop refresh interval                   │
└─────────────────────────────────────────────────────────────┘
```

## Pricing Resolution Pipeline

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

## State Persistence

Token history uses a **dual persistence** strategy:

1. **Session entries** — Each turn, `pi.appendEntry("token-cost-entry", entry)` persists **only the delta** (single new entry) in the session file. This avoids unbounded growth of the session log.
2. **File-based history** — Each entry is also appended to `~/.pi/agent/token-cost-history.json`, a standalone JSON file that survives across Pi sessions.

On session start, `loadHistory()` loads from both sources:

- Reads `token-cost-history.json` for historical data from previous sessions
- Scans current session `token-cost-entry` entries (may include entries not yet flushed to file)

This means:

- History survives **session restarts** (reload, crash)
- History survives **session forks/clones** (correct state for each branch point)
- History from **previous sessions** is available immediately on load
- Session log stays small — each entry is ~200 bytes instead of growing unboundedly

## Refresh Strategy

| Event | Action |
|-------|--------|
| Startup | Fetch OpenRouter API → save to cache file |
| Every 24h during active session | Re-fetch and update live prices |
| Cache TTL expired (>24h old) | Re-fetch on next startup |
| Network failure | Log warning, use embedded fallback DB |
