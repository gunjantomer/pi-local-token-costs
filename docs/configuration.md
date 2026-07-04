# Configuration

## User Price Overrides — `~/.pi/agent/token-costs.json`

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

You can also set overrides via the `/token-price --set` command:

```bash
/token-price --set ollama/qwen2.5-coder:32b 0.0 0.0
```

## Live Pricing Cache — `~/.pi/agent/token-costs-cache.json`

The extension caches OpenRouter API responses for **24 hours** to avoid redundant network calls. This file is auto-created and updated — do not edit manually. To force a refresh, delete the cache file or wait 24 hours.

## Extension Discovery

The extension is auto-discovered by pi when installed as a pi package:

```bash
# Install from npm
pi install npm:pi-local-token-costs

# Install from git
pi install git:github.com/gunjantomer/pi-local-token-costs@v1.0.0
```

No additional configuration needed — just restart pi or run `/reload` to activate.

## Dependencies

The extension requires [pi-powerline-footer](https://github.com/gsanhueza/pi-powerline-footer) for the footer display to work. Install it if you haven't already:

```bash
pi install npm:pi-powerline-footer
```
