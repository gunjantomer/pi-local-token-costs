/**
 * Generates a self-contained HTML contribution matrix (GitHub-style) for token usage data.
 * Blue color scheme with hover tooltips showing per-day cost and token details.
 * A block is rendered for every day in the requested range; only days with
 * token usage are colored (GitHub-contribution-matrix style).
 */

export interface DayData {
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Day of week (0=Sun, 6=Sat) */
  dayOfWeek: number;
  /** Day of month (1-31) */
  dayOfMonth: number;
  /** Month (0=Jan, 11=Dec) */
  month: number;
  /** Total input tokens used that day */
  inputTokens: number;
  /** Total output tokens used that day */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Total estimated cost in USD */
  costTotal: number;
  /** Breakdown by model ID */
  byModel: Record<
    string,
    { inputTokens: number; outputTokens: number; costTotal: number }
  >;
}

/** Format a Date as YYYY-MM-DD using LOCAL time (not UTC). */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Parse a YYYY-MM-DD string to a Date in local time. */
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** Options controlling the rendered range of the matrix grid. */
export interface MatrixOptions {
  /** Number of weeks to render (default: 12). Ignored when `months` is set. */
  weeks?: number;
  /** Number of months (~30 days each) to render. Takes precedence over `weeks`. */
  months?: number;
  /** Inclusive end date (YYYY-MM-DD, local time). Defaults to today. */
  endDate?: string;
}

/** A zeroed-out DayData for days with no token usage. */
function emptyDay(d: Date): DayData {
  return {
    date: localDateStr(d),
    dayOfWeek: d.getDay(),
    dayOfMonth: d.getDate(),
    month: d.getMonth(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costTotal: 0,
    byModel: {},
  };
}

/**
 * Organize days into weeks (columns). Each week starts on Sunday.
 *
 * The grid always spans the full requested range (ending `endDate`, default
 * today) rather than just the first-to-last data date, so the matrix keeps a
 * consistent size regardless of how sparsely the data covers the window.
 * Days without data are zero-filled DayData entries; only days after the end
 * date (future days in the last partial week) are null.
 */
function organizeIntoWeeks(
  data: DayData[],
  options: MatrixOptions = {},
): { weekStart: string; days: (DayData | null)[] }[] {
  if (data.length === 0) return [];

  const dateMap = new Map<string, DayData>();
  for (const d of data) {
    dateMap.set(d.date, d);
  }

  const months = options.months ?? 0;
  const weeks = months > 0 ? 0 : (options.weeks ?? 12);

  // Inclusive end of the window (local midnight).
  const end = options.endDate
    ? parseLocalDate(options.endDate)
    : new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        new Date().getDate(),
      );

  // Start of the window, aligned back to the previous Sunday (local time)
  const start = new Date(end);
  start.setDate(start.getDate() - (months > 0 ? months * 30 : weeks * 7));
  while (start.getDay() !== 0) {
    start.setDate(start.getDate() - 1);
  }

  const weeksOut: { weekStart: string; days: (DayData | null)[] }[] = [];
  const current = new Date(start);

  while (current <= end) {
    const weekDays: (DayData | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(current);
      d.setDate(d.getDate() + i);
      if (d > end) {
        weekDays.push(null); // future day in the last partial week
        continue;
      }
      const key = localDateStr(d);
      weekDays.push(dateMap.get(key) ?? emptyDay(d));
    }
    weeksOut.push({
      weekStart: localDateStr(current),
      days: weekDays,
    });
    current.setDate(current.getDate() + 7);
  }

  return weeksOut;
}

/** Generate a complete, self-contained HTML document as a string. */
export function generateMatrixHtml(
  data: DayData[],
  title: string,
  options: MatrixOptions = {},
): string {
  // Organize into weeks for the grid
  const weeks = organizeIntoWeeks(data, options);

  // Days actually rendered in the grid that have usage (zero-filled days and
  // out-of-window days are excluded so header stats match the picture).
  const activeDays = weeks
    .flatMap((w) => w.days)
    .filter((d): d is DayData => d !== null && d.totalTokens > 0);

  const maxCost = Math.max(...activeDays.map((d) => d.costTotal), 0.00001);

  // Collect unique model IDs for color assignment
  const modelList: string[] = [];
  for (const d of activeDays) {
    for (const m of Object.keys(d.byModel)) {
      if (!modelList.includes(m)) modelList.push(m);
    }
  }

  // Compute totals for the header
  const totalTokens = activeDays.reduce((s, d) => s + d.totalTokens, 0);
  const totalCost = activeDays.reduce((s, d) => s + d.costTotal, 0);
  const totalDays = activeDays.length;

  // Format numbers
  const fmtTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return `${n}`;
  };

  const fmtCost = (n: number) => {
    if (n >= 1) return `$${n.toFixed(2)}`;
    if (n >= 0.01) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(5)}`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-secondary: #161b22;
    --text: #c9d1d9;
    --text-muted: #8b949e;
    --border: #30363d;
    --cell-bg: #161b22;
    --tooltip-bg: #1c2333;
    --level-0: #161b22;
    --level-1: #0d3472;
    --level-2: #0e4a9a;
    --level-3: #1168bd;
    --level-4: #3182ce;
    --level-5: #5ba3d6;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    padding: 2rem;
    min-height: 100vh;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
  }

  header {
    margin-bottom: 2rem;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
    color: var(--text);
  }

  .subtitle {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
  }

  .stats {
    display: flex;
    gap: 2rem;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }

  .stat {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.5rem;
    min-width: 180px;
  }

  .stat-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
  }

  .stat-value {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text);
  }

  .controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .legend {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    flex-basis: 100%;
    gap: 0.5rem 1.5rem;
    margin-left: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .legend-cell {
    width: 12px;
    height: 12px;
    border-radius: 2px;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .legend-swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .matrix-wrapper {
    display: flex;
    overflow-x: auto;
    padding-bottom: 1rem;
  }

  .grid-body {
    display: grid;
    grid-template-rows: repeat(7, auto);
    gap: 2px;
    padding: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    width: max-content;
    flex: 0 0 auto;
  }

  .day-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 0.5rem;
    white-space: nowrap;
  }

  .cell {
    width: 100%;
    height: var(--cell-h, 20px);
    border-radius: 2px;
    background: var(--level-0);
    cursor: pointer;
    position: relative;
    transition: transform 0.1s ease, opacity 0.1s ease;
  }

  .cell:hover {
    transform: scale(1.25);
    opacity: 1 !important;
    z-index: 10;
    outline: 1.5px solid rgba(255, 255, 255, 0.75);
    outline-offset: 1px;
  }

  .cell[data-level="0"] { background: var(--level-0); }
  .cell[data-level="1"] { background: var(--level-1); }
  .cell[data-level="2"] { background: var(--level-2); }
  .cell[data-level="3"] { background: var(--level-3); }
  .cell[data-level="4"] { background: var(--level-4); }
  .cell[data-level="5"] { background: var(--level-5); }

  .tooltip {
    display: none;
    position: fixed;
    background: var(--tooltip-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.75rem 1rem;
    font-size: 0.8125rem;
    color: var(--text);
    z-index: 1000;
    pointer-events: none;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    min-width: 200px;
    max-width: 340px;
  }

  .tooltip.visible {
    display: block;
  }

  .tooltip-date {
    font-weight: 600;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
  }

  .tooltip-row {
    display: flex;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 0.125rem 0;
  }

  .tooltip-label {
    color: var(--text-muted);
  }

  .tooltip-value {
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .tooltip-models {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }

  .tooltip-model {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    font-size: 0.75rem;
    padding: 0.125rem 0;
    color: var(--text-muted);
  }

  .tooltip-model-name {
    flex: 1 1 auto;
    min-width: 0;
    word-break: break-all;
  }

  .tooltip-model-count {
    flex: 0 0 auto;
    white-space: nowrap;
    color: var(--text);
  }

  footer {
    margin-top: 2rem;
    text-align: center;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  @media (max-width: 768px) {
    body { padding: 1rem; }
    .stats { gap: 1rem; }
    .stat { min-width: 140px; padding: 0.75rem 1rem; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>${title}</h1>
    <p class="subtitle">Daily token usage and cost contribution matrix</p>
    <div class="stats">
      <div class="stat">
        <div class="stat-label">Total Tokens</div>
        <div class="stat-value">${fmtTokens(totalTokens)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total Cost</div>
        <div class="stat-value">${fmtCost(totalCost)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Active Days</div>
        <div class="stat-value">${totalDays}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Avg Cost/Day</div>
        <div class="stat-value">${fmtCost(totalCost / (totalDays || 1))}</div>
      </div>
    </div>
    <div class="controls">
      <div class="legend" id="modelLegend">
        <!-- Populated by JS -->
      </div>
    </div>
  </header>

  <div class="matrix-wrapper">
    <div class="grid-body" id="matrix"></div>
  </div>

  <div class="tooltip" id="tooltip"></div>

  <footer>
    Generated by pi-local-token-costs · ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
  </footer>
</div>

<script>
  const WEEKS = ${JSON.stringify(weeks)};
  const MODEL_LIST = ${JSON.stringify(modelList)};
  const MAX_COST = ${maxCost};

  /** Assign a distinct HSL color to each model. Golden-angle distribution for even hue spread. */
  function getModelColor(_modelId, index, _total) {
    const hue = (200 + ((index * 137.508) % 360)) % 360;
    return 'hsl(' + Math.round(hue) + ', 65%, 55%)';
  }

  /** Build gradient background for a cell based on model proportions */
  function buildGradient(day, orientation) {
    const axis = orientation || 'to bottom';
    const models = Object.entries(day.byModel || {});
    if (models.length === 0) return 'var(--cell-bg)';
    if (models.length === 1) {
      const idx = MODEL_LIST.indexOf(models[0][0]);
      return getModelColor(models[0][0], idx, MODEL_LIST.length);
    }
    // Sort by token count descending
    models.sort(([, a], [, b]) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
    const total = day.totalTokens || 1;
    const stops = [];
    let cumulative = 0;
    for (const [modelId, data] of models) {
      const share = (data.inputTokens + data.outputTokens) / total;
      const startPct = Math.round(cumulative * 100);
      cumulative += share;
      const endPct = Math.round(cumulative * 100);
      const idx = MODEL_LIST.indexOf(modelId);
      const color = getModelColor(modelId, idx, MODEL_LIST.length);
      stops.push(color + ' ' + startPct + '% ' + endPct + '%');
    }
    return 'linear-gradient(' + axis + ', ' + stops.join(', ') + ')';
  }

  function getLevel(value, max) {
    if (value === 0) return 0;
    const ratio = value / max;
    if (ratio < 0.2) return 1;
    if (ratio < 0.4) return 2;
    if (ratio < 0.6) return 3;
    if (ratio < 0.8) return 4;
    return 5;
  }

  function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
    return n.toString();
  }

  function fmtCost(n) {
    if (n >= 1) return '$' + n.toFixed(2);
    if (n >= 0.01) return '$' + n.toFixed(3);
    return '$' + n.toFixed(5);
  }

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Layout sizing. We measure the available width and derive a per-week column width, then
  // pick a mode:
  //   - SQUARE: the column fits in a square (<= SQUARE_MAX). Cells are square and model
  //     colors stack vertically (top -> bottom).
  //   - ELONGATED: the available width would make cells wider than SQUARE_MAX (i.e. there are
  //     not enough weeks to fill the grid with sensible squares). Cells become elongated bars
  //     (capped at ELONG_MAX wide, ELONG_H tall) and the model colors run side by side
  //     (left -> right), so the extra width is actually used instead of producing giant blocks.
  const SQUARE_MAX = 24;  // widest we keep a block square before switching to elongated
  const CELL_MIN   = 12;  // floor for square blocks
  const ELONG_MAX  = 96;  // max width for elongated (side-by-side) blocks
  const ELONG_H    = 16;  // fixed height for elongated blocks
  const LABEL_COL  = 48;  // width of the day-label column (3rem)
  const GAP_PX     = 2;   // grid gap between columns

  function computeLayout() {
    const wrapper = document.querySelector('.matrix-wrapper');
    const numWeeks = WEEKS.length;
    if (!wrapper || numWeeks === 0) {
      return { cellW: SQUARE_MAX, cellH: SQUARE_MAX, orientation: 'to bottom' };
    }
    const padBorder = 18; // grid-body: 8px padding * 2 + 1px border * 2
    const gaps = numWeeks * GAP_PX;
    const perWeek = (wrapper.clientWidth - padBorder - LABEL_COL - gaps) / numWeeks;
    if (perWeek <= SQUARE_MAX) {
      const w = Math.max(CELL_MIN, Math.round(perWeek));
      return { cellW: w, cellH: w, orientation: 'to bottom' };
    }
    const w = Math.min(ELONG_MAX, Math.round(perWeek));
    return { cellW: w, cellH: ELONG_H, orientation: 'to right' };
  }

  function buildMatrix() {
    const matrix = document.getElementById('matrix');
    matrix.innerHTML = '';
    const numWeeks = WEEKS.length;
    const layout = computeLayout();
    matrix.style.setProperty('--cell-h', layout.cellH + 'px');
    matrix.style.gridTemplateColumns = '3rem repeat(' + numWeeks + ', ' + layout.cellW + 'px)';

    for (let d = 0; d < 7; d++) {
      const label = document.createElement('div');
      label.className = 'day-label';
      label.textContent = DAY_NAMES[d];
      matrix.appendChild(label);

      for (let w = 0; w < numWeeks; w++) {
        const day = WEEKS[w].days[d];
        const cell = document.createElement('div');
        cell.className = 'cell';

        if (!day) {
          // Day falls after the end of the window (future days in the last
          // partial week) — no block is rendered for it.
          cell.setAttribute('data-level', 0);
          cell.style.visibility = 'hidden';
        } else if (day.totalTokens === 0) {
          // Day in the window with no usage — render the empty level-0 block
          // (like GitHub's contribution grid) with a minimal tooltip.
          cell.setAttribute('data-level', 0);
          cell.setAttribute('data-date', day.date);
          cell.setAttribute('data-empty', 'true');
          cell.addEventListener('mouseenter', showTooltip);
          cell.addEventListener('mouseleave', hideTooltip);
          cell.addEventListener('mousemove', moveTooltip);
        } else {
          // Intensity is always keyed to cost — the tool estimates each day's cost as if run
          // on the OpenRouter API, so "which days were costly" is the useful signal.
          const level = getLevel(day.costTotal, MAX_COST);
          cell.setAttribute('data-level', level);
          cell.setAttribute('data-date', day.date);
          cell.setAttribute('data-tokens', day.totalTokens);
          cell.setAttribute('data-input', day.inputTokens);
          cell.setAttribute('data-output', day.outputTokens);
          cell.setAttribute('data-cost', day.costTotal);
          cell.setAttribute('data-models', JSON.stringify(day.byModel || {}));

          // Apply gradient background based on model proportions (orientation depends on layout)
          cell.style.background = buildGradient(day, layout.orientation);

          // Cost-based intensity: high-cost days render at full opacity, low-cost days fade out.
          // The gradient above carries the model mix, while opacity carries the cost amount.
          cell.style.opacity = (0.2 + 0.8 * (level / 5)).toFixed(2);

          cell.addEventListener('mouseenter', showTooltip);
          cell.addEventListener('mouseleave', hideTooltip);
          cell.addEventListener('mousemove', moveTooltip);
        }

        matrix.appendChild(cell);
      }
    }
  }

  function showTooltip(e) {
    const tooltip = document.getElementById('tooltip');
    const cell = e.target;
    const date = cell.getAttribute('data-date');

    const dateObj = new Date(date + 'T00:00:00');
    const dateStr = dateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    if (cell.getAttribute('data-empty') === 'true') {
      tooltip.innerHTML =
        '<div class="tooltip-date">' + dateStr + '</div>' +
        '<div class="tooltip-row"><span class="tooltip-label">Usage</span><span class="tooltip-value">No token usage</span></div>';
      tooltip.classList.add('visible');
      return;
    }

    const tokens = parseInt(cell.getAttribute('data-tokens'));
    const input = parseInt(cell.getAttribute('data-input'));
    const output = parseInt(cell.getAttribute('data-output'));
    const cost = parseFloat(cell.getAttribute('data-cost'));
    const models = JSON.parse(cell.getAttribute('data-models') || '{}');

    let html = '<div class="tooltip-date">' + dateStr + '</div>';
    html += '<div class="tooltip-row"><span class="tooltip-label">Cost</span><span class="tooltip-value">' + fmtCost(cost) + '</span></div>';
    html += '<div class="tooltip-row"><span class="tooltip-label">Input tokens</span><span class="tooltip-value">' + fmtTokens(input) + '</span></div>';
    html += '<div class="tooltip-row"><span class="tooltip-label">Output tokens</span><span class="tooltip-value">' + fmtTokens(output) + '</span></div>';
    html += '<div class="tooltip-row"><span class="tooltip-label">Total tokens</span><span class="tooltip-value">' + fmtTokens(tokens) + '</span></div>';

    if (Object.keys(models).length > 0) {
      html += '<div class="tooltip-models">';
      html += '<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem;">Models used:</div>';
      for (const [modelId, data] of Object.entries(models)) {
        const displayName = modelId.replace(/^[^/]+[/]/, '').replace(/[/]/g, '/');
        html += '<div class="tooltip-model"><span class="tooltip-model-name">' + escapeHtml(displayName) + '</span><span class="tooltip-model-count">' + fmtTokens(data.inputTokens + data.outputTokens) + ' · ' + fmtCost(data.costTotal) + '</span></div>';
      }
      html += '</div>';
    }

    tooltip.innerHTML = html;
    tooltip.classList.add('visible');
  }

  function moveTooltip(e) {
    const tooltip = document.getElementById('tooltip');
    const margin = 8;
    const offset = 12;
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer right of and slightly above the cursor; flip or clamp at any edge
    // so the tooltip is never rendered off-screen.
    let x = e.clientX + offset;
    let y = e.clientY - 10;
    if (x + w > vw - margin) x = e.clientX - w - offset; // flip to the left
    x = Math.min(Math.max(x, margin), vw - margin - w); // final horizontal clamp
    if (y + h > vh - margin) y = vh - margin - h; // flip above the cursor
    y = Math.min(Math.max(y, margin), vh - margin - h); // final vertical clamp

    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideTooltip() {
    const tooltip = document.getElementById('tooltip');
    tooltip.classList.remove('visible');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Build model color legend */
function buildLegend() {
const legend = document.getElementById('modelLegend');
if (!MODEL_LIST || MODEL_LIST.length === 0) return;

let html = '';
for (let i = 0; i < MODEL_LIST.length; i++) {
const modelId = MODEL_LIST[i];
const displayName = modelId.replace(/^[^/]+[/]/, '').replace(/[/]/g, '/');
const color = getModelColor(modelId, i, MODEL_LIST.length);
html += '<div class="legend-item"><div class="legend-swatch" style="background: ' + color + '"></div><span>' + escapeHtml(displayName) + '</span></div>';
}
legend.innerHTML = html;
}

buildMatrix();
buildLegend();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildMatrix, 120);
});
</script>
</body>
</html>`;
}
