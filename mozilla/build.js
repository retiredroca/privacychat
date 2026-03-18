#!/usr/bin/env node
/**
 * CryptoChat build.js
 *
 * Why two manifests?
 *
 *   Chrome MV3:  "background": { "service_worker": "..." }
 *                "scripts" key → REJECTED ("requires manifest version 2 or lower")
 *
 *   Firefox MV3: "background": { "scripts": ["..."] }
 *                "service_worker" → status code 15, silent fail
 *
 * They are mutually exclusive. The fix: two manifest files, a build step
 * that copies the right one into place per browser.
 *
 * Usage:
 *   node build.js              — verify all files are present
 *   node build.js firefox      — swap manifest.firefox.json → manifest.json
 *   node build.js restore      — restore manifest.json to Chrome version
 *   node build.js pack         — build dist/cryptochat-chrome.zip + dist/cryptochat-firefox.xpi
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const B = s => `\x1b[34m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

const REQUIRED = [
  'manifest.json',
  'manifest.firefox.json',
  'src/background-loader.js',
  'src/background-bundle.js',
  'src/content.js',
  'src/ui/popup.html',
  'src/ui/popup.css',
  'src/ui/popup.js',
  'src/adapters/discord.js',
  'src/adapters/slack.js',
  'src/adapters/others.js',
  'src/adapters/instagram.js',
  'src/adapters/twitter.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

function verify() {
  console.log(B('\nCryptoChat — file verification\n'));
  let ok = true;
  for (const f of REQUIRED) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) {
      const kb = (fs.statSync(full).size / 1024).toFixed(1);
      console.log(G('  ✓') + `  ${f.padEnd(44)} ${kb} KB`);
    } else {
      console.log(R('  ✗  MISSING: ') + f);
      ok = false;
    }
  }

  // Chrome manifest must NOT have scripts[]
  const cm = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json')));
  if (cm.background?.scripts) {
    console.log(R('\n  ✗  manifest.json has "scripts" — Chrome will reject this!'));
    ok = false;
  } else {
    console.log(G('  ✓') + '  manifest.json: no "scripts" key (Chrome-safe)');
  }

  // Firefox manifest must NOT have service_worker
  const fm = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.firefox.json')));
  if (fm.background?.service_worker) {
    console.log(R('\n  ✗  manifest.firefox.json has "service_worker" — Firefox will reject this!'));
    ok = false;
  } else {
    console.log(G('  ✓') + '  manifest.firefox.json: no "service_worker" (Firefox-safe)');
  }

  console.log('');
  return ok;
}

function useFirefox() {
  const backup = path.join(ROOT, 'manifest.chrome.json');
  fs.copyFileSync(path.join(ROOT, 'manifest.json'), backup);
  fs.copyFileSync(path.join(ROOT, 'manifest.firefox.json'), path.join(ROOT, 'manifest.json'));
  console.log(G('\n✓ manifest.json swapped to Firefox version.'));
  console.log(Y('  Chrome version backed up to manifest.chrome.json\n'));
  console.log(B('Load in Firefox:'));
  console.log('  Temporary:   about:debugging → This Firefox → Load Temporary Add-on → manifest.json');
  console.log('  Persistent:  node build.js pack  →  install dist/cryptochat-firefox.xpi\n');
}

function restoreChrome() {
  const backup = path.join(ROOT, 'manifest.chrome.json');
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, path.join(ROOT, 'manifest.json'));
    console.log(G('\n✓ manifest.json restored to Chrome version.\n'));
  } else {
    console.log(Y('\nNo manifest.chrome.json backup found — manifest.json not changed.\n'));
  }
}

function zipDir(srcDir, outFile, excludePatterns) {
  const excl = excludePatterns.map(e => `--exclude="${e}" --exclude="*/${e}"`).join(' ');
  execSync(`cd "${srcDir}" && zip -r "${outFile}" . ${excl} -q`);
}

function pack() {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });

  const EXCLUDES_BASE = [
    'dist', 'node_modules', '.git', '.DS_Store',
    'manifest.chrome.json', '*.zip', '*.xpi'
  ];

  // ── Chrome ────────────────────────────────────────────────────────────
  // Ensure Chrome manifest is active (no scripts[])
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json')));
  if (current.background?.scripts) restoreChrome();

  const chromeOut = path.join(ROOT, 'dist', 'cryptochat-chrome.zip');
  zipDir(ROOT, chromeOut, [...EXCLUDES_BASE, 'manifest.firefox.json']);
  console.log(G(`✓ Chrome:  dist/cryptochat-chrome.zip`));

  // ── Firefox ───────────────────────────────────────────────────────────
  const chromeManifest = fs.readFileSync(path.join(ROOT, 'manifest.json'));
  fs.copyFileSync(path.join(ROOT, 'manifest.firefox.json'), path.join(ROOT, 'manifest.json'));

  const ffOut = path.join(ROOT, 'dist', 'cryptochat-firefox.xpi');
  zipDir(ROOT, ffOut, [...EXCLUDES_BASE, 'manifest.firefox.json']);
  console.log(G(`✓ Firefox: dist/cryptochat-firefox.xpi`));

  // Restore Chrome manifest
  fs.writeFileSync(path.join(ROOT, 'manifest.json'), chromeManifest);
  console.log(G(`✓ manifest.json restored to Chrome version.\n`));

  console.log(B('Install Chrome:   ') + 'Unzip cryptochat-chrome.zip → chrome://extensions → Load unpacked');
  console.log(B('Install Firefox:  ') + 'Drag cryptochat-firefox.xpi onto Firefox Dev Edition\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────
const cmd = process.argv[2];
const ok  = verify();

switch (cmd) {
  case 'firefox': useFirefox();    break;
  case 'restore': restoreChrome(); break;
  case 'pack':
    if (!ok) { console.log(R('Fix the errors above before packing.\n')); process.exit(1); }
    pack();
    break;
  default:
    if (ok) {
      console.log(B('Commands:'));
      console.log('  node build.js            — verify files (you are here)');
      console.log('  node build.js firefox    — swap to Firefox manifest');
      console.log('  node build.js restore    — restore Chrome manifest');
      console.log('  node build.js pack       — build both Chrome zip + Firefox xpi\n');
      console.log(B('Chrome/Brave/Edge:  ') + 'chrome://extensions → Developer mode → Load unpacked');
      console.log(B('Firefox:            ') + 'node build.js firefox  then  about:debugging → Load Temporary Add-on\n');
    } else {
      process.exit(1);
    }
}
