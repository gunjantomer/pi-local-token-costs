# Changelog

### Upcoming — Token usage contribution matrix and cross-session file persistence

**New feature:** `/token-matrix` command generates a GitHub-style contribution grid showing daily token usage and cost, viewable in your default browser.

**Features:**

- 7-row (days) × N-column (weeks) heatmap with per-model color gradients
- Toggle between cost ($) and token count views
- Hover tooltips with per-model breakdown (cost, input/output tokens)
- Dynamic model legend with color swatches
- Configurable date range via `--weeks N` (default: 12) or `--months N`

**Cross-session file persistence:** Token history is now saved to `~/.pi/agent/token-cost-history.json` so data survives across Pi sessions. Previously, `sessionManager.getEntries()` only returned entries from the current session, so history was lost on restart.

**Changes:**

- `extensions/matrix-html.ts` — new module: `generateMatrixHtml()` with week-based grid, per-model HSL colors, and client-side tooltips
- `extensions/token-costs.ts` — `/token-matrix` command registration, file-based persistence, cross-platform browser open
- `README.md` — documented new command and feature
- `docs/token-matrix.md` — new dedicated documentation page

### 2026-07-23 — 1.0.4: Fix "Invalid string length" error on long sessions

**Problem:** On long sessions, `pi.appendEntry("token-cost-history", history)` appended the entire growing `history.entries` array every turn. This caused the session log to grow unboundedly, eventually exceeding the JavaScript string length limit during `JSON.stringify` in `SessionManager._persist`, throwing "Invalid string length" on every turn.

**Fix:** Changed to append only the **delta** (`pi.appendEntry("token-cost-entry", entry)`) — each entry is ~200 bytes instead of the entire history object. `loadHistory()` now reads `token-cost-entry` entries and reconstructs the full history. Backward compatibility is maintained for old `token-cost-history` entries.

**Changes:**

- `extensions/token-costs.ts` — Append only delta entry in `message_end` and `record-tool-cost` handlers
- `extensions/token-costs.ts` — `loadHistory()` reads `token-cost-entry` entries (with backward compat for old format)
- `docs/architecture.md` — Updated State Persistence section

### 2026-07-04 — 1.0.3: Dead code cleanup and code quality improvements

**Changes:**

1. **Removed 4 unused functions** that were leftover from refactoring:
   - `extractBaseModel` — never called
   - `stripParameterSuffix` — never called
   - `extractParamCounts` — never called
   - `lookupPrice` — just wrapped `resolveModel`

2. **Removed orphaned JSDoc comments** for the deleted functions

3. **Removed unused `COMMON_SUFFIXES` constant**

4. **Removed duplicate `qwen2.5-coder`** from `LOCAL_MODEL_DEFAULTS` (already in `FALLBACK_PRICES` with real pricing; local entry was unreachable)

5. **Extracted `keyMatches()` helper** — replaced 3 copy-pasted call sites for the repeated fallback matching logic

6. **Split long template literals** to stay under 150-char line limit

**Result:** Line count reduced from 1659 → 1604 (net -55 lines)

### 2026-07-04 — Removed system-specific paths from public package

**Problem**: Example paths in docs and code comments referenced a specific Windows drive (`A:\lmstudio-models\`) and local repo path (`A:\code-backup\`), which are not relevant for other users.

**Fixes applied:**

1. **Generalized example paths** in `token-costs.ts` and `docs/model-matching.md` to use cross-platform `/path/to/` instead of Windows-specific `A:\` paths
2. **Removed local repo path** from `docs/troubleshooting.md` — now references `npm:pi-local-token-costs` only

### 2026-07-04 — Restructured documentation

Moved changelog entries to a separate `CHANGELOG.md` file. Added `docs/` folder with dedicated pages for configuration, model matching, architecture, and troubleshooting.

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
