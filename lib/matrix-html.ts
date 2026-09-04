/**
 * Generates a self-contained HTML contribution matrix (GitHub-style) for token usage data.
 * Blue color scheme with hover tooltips showing per-day cost and token details.
 * Supports toggle between cost and token views.
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

/** Organize days into weeks (columns). Each week starts on Sunday. */
function organizeIntoWeeks(
  data: DayData[],
): { weekStart: string; days: (DayData | null)[] }[] {
  if (data.length === 0) return [];

  const dateMap = new Map<string, DayData>();
  for (const d of data) {
    dateMap.set(d.date, d);
  }

  const firstDate = data[0].date;
  const lastDate = data[data.length - 1].date;

  // Find the Sunday before or on the first date (local time)
  const start = parseLocalDate(firstDate);
  while (start.getDay() !== 0) {
    start.setDate(start.getDate() - 1);
  }

  const last = parseLocalDate(lastDate);

  const weeks: { weekStart: string; days: (DayData | null)[] }[] = [];
  const current = new Date(start);

  while (current <= last) {
    const weekDays: (DayData | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(current);
      d.setDate(d.getDate() + i);
      const key = localDateStr(d);
      weekDays.push(dateMap.get(key) || null);
    }
    weeks.push({
      weekStart: localDateStr(current),
      days: weekDays,
    });
    current.setDate(current.getDate() + 7);
  }

  return weeks;
}

/** Generate a complete, self-contained HTML document as a string. */
export function generateMatrixHtml(data: DayData[], title: string): string {
  const maxTokens = Math.max(...data.map((d) => d.totalTokens), 1);
  const maxCost = Math.max(...data.map((d) => d.costTotal), 0.00001);

  // Organize into weeks for the grid
  const weeks = organizeIntoWeeks(data);

  // Collect unique model IDs for color assignment
  const modelList: string[] = [];
  for (const d of data) {
    for (const m of Object.keys(d.byModel)) {
      if (!modelList.includes(m)) modelList.push(m);
    }
  }

  // Compute totals for the header
  const totalTokens = data.reduce((s, d) => s + d.totalTokens, 0);
  const totalCost = data.reduce((s, d) => s + d.costTotal, 0);
  const totalDays = data.length;

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
    --toggle-bg: #21262d;
    --toggle-active: #3182ce;
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

  .toggle-group {
    display: flex;
    background: var(--toggle-bg);
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--border);
  }

  .toggle-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    background: transparent;
    color: var(--text-muted);
    border: none;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
  }

  .toggle-btn:hover {
    color: var(--text);
  }

  .toggle-btn.active {
    background: var(--toggle-active);
    color: #fff;
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
    background: var(--bg-secondary);
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
    transition: transform 0.1s ease;
  }

  .cell:hover {
    transform: scale(1.4);
    z-index: 10;
    border: 1px solid rgba(255,255,255,0.2);
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
    font-size: 0.75rem;
    padding: 0.125rem 0;
    color: var(--text-muted);
  }

  .tooltip-model span {
    color: var(--text);
    float: right;
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
      <div class="toggle-group">
        <button class="toggle-btn active" data-mode="cost" onclick="setMode('cost')">Cost ($)</button>
        <button class="toggle-btn" data-mode="tokens" onclick="setMode('tokens')">Tokens</button>
      </div>
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
  const MAX_TOKENS = ${maxTokens};
  const MAX_COST = ${maxCost};
  let currentMode = 'cost';

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

        if (day) {
          const value = currentMode === 'cost' ? day.costTotal : day.totalTokens;
          const max = currentMode === 'cost' ? MAX_COST : MAX_TOKENS;
          const level = getLevel(value, max);
          cell.setAttribute('data-level', level);
          cell.setAttribute('data-date', day.date);
          cell.setAttribute('data-tokens', day.totalTokens);
          cell.setAttribute('data-input', day.inputTokens);
          cell.setAttribute('data-output', day.outputTokens);
          cell.setAttribute('data-cost', day.costTotal);
          cell.setAttribute('data-models', JSON.stringify(day.byModel || {}));

          // Apply gradient background based on model proportions (orientation depends on layout)
          cell.style.background = buildGradient(day, layout.orientation);

          cell.addEventListener('mouseenter', showTooltip);
          cell.addEventListener('mouseleave', hideTooltip);
          cell.addEventListener('mousemove', moveTooltip);
        } else {
          cell.setAttribute('data-level', 0);
          cell.style.visibility = 'hidden';
        }

        matrix.appendChild(cell);
      }
    }
  }

  function showTooltip(e) {
    const tooltip = document.getElementById('tooltip');
    const cell = e.target;
    const date = cell.getAttribute('data-date');
    const tokens = parseInt(cell.getAttribute('data-tokens'));
    const input = parseInt(cell.getAttribute('data-input'));
    const output = parseInt(cell.getAttribute('data-output'));
    const cost = parseFloat(cell.getAttribute('data-cost'));
    const models = JSON.parse(cell.getAttribute('data-models') || '{}');

    const dateObj = new Date(date + 'T00:00:00');
    const dateStr = dateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

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
        html += '<div class="tooltip-model">' + escapeHtml(displayName) + ' <span>' + fmtTokens(data.inputTokens + data.outputTokens) + ' · ' + fmtCost(data.costTotal) + '</span></div>';
      }
      html += '</div>';
    }

    tooltip.innerHTML = html;
    tooltip.classList.add('visible');
  }

  function moveTooltip(e) {
    const tooltip = document.getElementById('tooltip');
    const x = e.clientX + 12;
    const y = e.clientY - 10;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function hideTooltip() {
    const tooltip = document.getElementById('tooltip');
    tooltip.classList.remove('visible');
  }

  function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    buildMatrix();
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
