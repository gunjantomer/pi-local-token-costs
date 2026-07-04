# pi-local-token-costs

Token cost tracking extension for [Pi](https://pi.dev). Tracks token usage and estimated costs for every model in every session. Shows live costs in the powerline footer, maintains cross-session history, and always uses the cheapest available provider pricing from OpenRouter.

## Key Features

- **Live pricing** from 30+ providers (cheapest rate automatically selected)
- **Accurate local model matching** via dot-preserved keys, GGUF stripping, and param-count-aware strategies
- **Savings comparison** — see what running locally costs vs. online equivalents
- **Cross-session history** with per-model breakdowns
- **Offline fallback** with ~60 cloud models + Qwen family pricing

## Installation

```bash
# From npm
pi install npm:pi-local-token-costs

# From git
pi install git:github.com/Greys-Coding/pi-local-token-costs@v1.0.0
```

Requires [pi-powerline-footer](https://github.com/gsanhueza/pi-powerline-footer) for the footer display. Restart pi or run `/reload` after installing.

## Live Footer Display

The powerline footer shows real-time token counts and estimated cost:

```
↑in: 142k ↓out: 28k $0.20000 · Qwen3.6-35B-A3B |
```

- `↑in:` = input tokens consumed this session (dynamic, updates while streaming)
- `↓out:` = output tokens generated this session (dynamic)
- `$X.XXXXX` = cumulative estimated cost (cheapest provider pricing, 5 decimal places)
- Model name shown in green if priced match, red if not

## Commands

| Command | Description |
|---------|-------------|
| `/token-stats` | Show current session's token usage and cost breakdown by model |
| `/token-history` | Show cross-session history of the last 50 messages, grouped by model with pricing source |
| `/token-clear` | Clear all persisted token usage history (with confirmation) |
| `/token-price <model-id>` | Show how a specific model is resolved and priced |
| `/token-price --set <id> $in $out` | Set a custom price override for any model ID |

## Documentation

- [Configuration](docs/configuration.md) — User price overrides, cache file, dependencies
- [Model Matching](docs/model-matching.md) — Normalization, stripping strategies, priority chain
- [Architecture](docs/architecture.md) — Data flow, pricing pipeline, state persistence
- [Troubleshooting](docs/troubleshooting.md) — Common issues and fixes
- [Changelog](CHANGELOG.md) — Release history

## License

MIT
