# Token Usage Matrix

The `/token-matrix` command generates a GitHub-style contribution grid showing daily token usage and estimated cost, viewable in your default browser.

## Usage

```bash
/token-matrix              # Show last 12 weeks (default)
/token-matrix --weeks 4    # Show last 4 weeks
/token-matrix --weeks 26   # Show last 26 weeks (~6 months)
/token-matrix --months 3   # Show last 3 months
```

## Visual Layout

The matrix displays:

- **Rows**: Days of the week (Sun–Sat)
- **Columns**: Weeks, starting from the Sunday of the first week
- **Blocks**: A block is rendered for **every day** in the requested range. The grid always spans the full `--weeks`/`--months` window ending today — not just the days with data — so its size stays consistent regardless of data sparsity
- **Color**: Each model gets a unique color. Days with multiple models show a proportional gradient. Days without token usage render as empty blocks (no color), like GitHub's contribution grid
- **Intensity**: Darker/more saturated cells indicate higher usage (5 levels based on cost)

## Interactive Features

| Feature | Description |
|---------|-------------|
| **Hover tooltips** | Hover any cell to see date, cost, input/output tokens, and per-model breakdown. Empty days show "No token usage". |
| **Model legend** | Dynamic legend shows each model's color swatch and name |
| **Stats header** | Total tokens, total cost, active days, and average cost/day |

## Data Source

The matrix reads from the same cross-session history used by `/token-history` and `/token-stats`. History is persisted to `~/.pi/agent/token-cost-history.json` so it survives across Pi sessions and reloads.

If there is no history in the requested range, the command reports this instead of opening a grid. Start using Pi with local models for a few turns, then run `/token-matrix` again.

## Technical Details

- **HTML output**: A self-contained HTML file with inline CSS/JS is written to your temp directory and opened in the default browser
- **Color assignment**: Models are assigned colors using golden-angle HSL distribution (starting at hue 200/blue) for even visual separation
- **Date handling**: All dates use local time (not UTC) to match your calendar day
- **Browser open**: Uses `start` (Windows), `open` (macOS), or `xdg-open` (Linux) with fallback notification
