#!/usr/bin/env node
/**
 * Syncs version numbers across the project to match package.json.
 *
 * Finds patterns like `@v1.2.3` and `@v1.0.0` in markdown and config files,
 * then replaces them with the version from package.json.
 *
 * Run via `npm run sync-version` or automatically before publish.
 *
 * Usage:
 *   node scripts/sync-version.js          # replace in-place
 *   node scripts/sync-version.js --dry    # preview changes without writing
 */

const fs = require('fs');
const path = require('path');

const SELF = path.resolve(__filename);
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

// ── Read version from package.json ──────────────────────────────────────
const pkgPath = path.join(ROOT, 'package.json');
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (err) {
  console.error(`ERROR: Failed to parse package.json: ${err.message}`);
  process.exit(1);
}

const version = pkg.version;
if (!version) {
  console.error('ERROR: package.json has no "version" field.');
  process.exit(1);
}

console.log(`Target version: ${version}`);

// ── Patterns to find and replace ────────────────────────────────────────
// Each entry: { regex, replacement }
// Only matches git tag / release refs like @v1.2.3
// Historical versions in CHANGELOG.md are safe — they don't use the @v prefix.
const PATTERNS = [
  // GitHub release/tag refs: @v1.2.3 → @v1.2.3 (current)
  { regex: /@v\d+\.\d+\.\d+/g, replacement: (m) => `@v${version}` },
];

// ── Collect all text files (exclude node_modules, .git, package-lock) ──
function collectFiles(dir, list = []) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === 'node_modules' || entry === '.git' || entry === '.pi-lens') continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, list);
    } else if (stat.isFile() && /\.(md|txt|json|yml|yaml|sh|html|css)$/.test(entry) && entry !== 'package-lock.json' && entry !== 'CHANGELOG.md' && full !== SELF && full !== pkgPath) {
      list.push(full);
    }
  }
  return list;
}

const files = collectFiles(ROOT);

// ── Replace versions ───────────────────────────────────────────────────
let count = 0;
for (const filePath of files) {
  const content = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  let updated = content;

  for (const { regex, replacement } of PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(updated)) {
      changed = true;
      updated = updated.replace(regex, replacement);
    }
  }

  if (!changed) continue;

  const rel = path.relative(ROOT, filePath);
  if (DRY) {
    console.log(`  [dry-run] ${rel}`);
  } else {
    fs.writeFileSync(filePath, updated, 'utf8');
    console.log(`  synced  ${rel}`);
  }
  count++;
}

if (count === 0) {
  console.log('  No files needed updating — versions are already in sync.');
} else {
  console.log(`\nSynced ${count} file${count > 1 ? 's' : ''} to v${version}.`);
}
