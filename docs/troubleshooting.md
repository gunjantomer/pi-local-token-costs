# Troubleshooting

## "Using cached pricing data" in console

This is normal — the extension caches OpenRouter API responses for 24 hours. To force a refresh:

```bash
rm ~/.pi/agent/token-costs-cache.json   # Delete cache file
pi --reload                               # Restart pi
```

## Wrong price shown for a model

1. Check what source the model resolved to:

   ```bash
   /token-price <your-model-id>
   ```

2. If it shows `fallback-local` or `local-default`, add an explicit override:

   ```bash
   /token-price --set ollama/your-model 0.0 0.0
   ```

3. If the resolved key doesn't match your model, check the normalization pipeline. See [Model Matching](./model-matching.md) for details on how model IDs are normalized and matched.

## Extension not showing in footer

Make sure [pi-powerline-footer](https://github.com/gsanhueza/pi-powerline-footer) is installed and active. The extension uses `setStatus("tokenCosts", text)` which powerline renders in its `extension_statuses` segment.

Verify the extension is enabled:

```bash
pi config
```

Look for `A:\code-backup\pi-local-token-costs` (or `npm:pi-local-token-costs`) with `token-costs.ts` checked `[x]`.

## Local model shows $0 cost

This is expected for truly local/free models. The extension will show a savings comparison if an online equivalent is found. To see the online price:

```bash
/token-price ollama/qwen3.6-35b-a3b
```

Output includes `comparableOnlinePrice` showing the cheapest cloud equivalent rate.

## Offline mode

The extension works fully offline using its embedded fallback database (~60 cloud models + local model defaults). The only feature that requires network access is live price fetching — everything else (tracking, history, commands) works without it.
