#!/usr/bin/env node
/**
 * Replaces {{VERSION}} placeholders in tracked files with the version from package.json.
 *
 * Run via `npm run sync-version` or automatically before publish.
 *
 * Usage:
 *   node scripts/sync-version.js          # replace in-place
 *   node scripts/sync-version.js --dry    # preview changes without writing
 */

const fs = require('fs');
const path = require('path');

const PLACEHOLDER = '{{VERSION}}';
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

console.log(`Version: ${version}`);

// ── Collect all text files (exclude node_modules, .git, package-lock) ──
function collectFiles(dir, list = []) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === 'node_modules' || entry === '.git' || entry === '.pi-lens')
      continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, list);
    } else if (
      stat.isFile() &&
      /\.(md|txt|ts|js|json|yml|yaml|sh|html|css)$/.test(entry) &&
      entry !== 'package-lock.json' &&
      full !== SELF
    ) {
      list.push(full);
    }
  }
  return list;
}

const files = collectFiles(ROOT);

// ── Replace placeholders ───────────────────────────────────────────────
let count = 0;
for (const filePath of files) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(PLACEHOLDER)) continue;

  const updated = content.replace(new RegExp(PLACEHOLDER, 'g'), version);
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
  console.log(`  No files with ${PLACEHOLDER} found — nothing to do.`);
} else {
  console.log(`\nSynced ${count} file${count > 1 ? 's' : ''} to v${version}.`);
}
