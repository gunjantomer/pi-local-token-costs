# Model Matching

When tracking usage, the extension maps whatever model ID pi reports (e.g., `ollama/qwen2.5-coder:32b`, `Qwen/Qwen3.6-35B-A3B-Instruct`, full LM Studio file paths) to a pricing entry using this **priority chain**:

```
1. User config override (exact model ID match)      → ~/.pi/agent/token-costs.json
2. User config override (normalized model ID)        → normalized = lowercase, no prefixes
3. Live OpenRouter API (cheapest provider rate)      → fetched at startup + refreshed every 24h
4. Stripping-based matching against live prices     → progressive strategies
5. Alias rules (regex patterns for common naming)    → handles Ollama, vLLM, LM Studio conventions
6. Embedded fallback DB (~60 cloud models + Qwen family) → works offline for known models
7. Local model defaults ($0/$0)                      → unknown models assumed free/local
```

## Normalization

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
| `Qwen/Qwen3.6-35B-A3B-Instruct` | `qwen3.6-35b-a3b-instruct` | Direct fallback → $0.14/M input |
| `A:\lmstudio-models\...\Qwen3.6-35B-A3B-Q4_K_M.gguf` | `qwen3.6-35b-a3b-q4-k-m` | Dot-preserved fallback → $0.14/M input |
| `ollama/qwen2.5-coder:32b` | `qwen2.5-coder:32b` | Alias rule → Qwen2.5 Coder ($0.66/$1.00 per M tokens) |
| `gemma4-26B-A3B-QAT` | `gemma4-26b-a3b-qat` | Stripping (-a3b-qat) → family match → `gemma4` |

## Stripping-Based Matching

When a normalized model ID doesn't directly match any entry, the extension tries **progressive stripping strategies** that preserve param counts through multiple levels:

1. **GGUF quantization tag removal** — `qwen3.6-35b-a3b-q4-k-m` → `qwen3.6-35b-a3b`
2. **Strip semantic suffixes, KEEPING params & variants** — `qwen3.6-35b-a3b-instruct` → `qwen3.6-35b-a3b`
3. **Strip variant tags (-a3b, -qat), KEEPING param count** — `qwen3.6-35b-a3b` → `qwen3.6-35b`
4. **Strip variant tags + semantic suffixes, KEEPING param count** — `qwen3.6-35b-a3b-instruct` → `qwen3.6-35b`
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
