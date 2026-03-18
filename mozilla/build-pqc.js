#!/usr/bin/env node
/**
 * build-pqc.js
 *
 * Bundles the `mlkem` npm package (NIST FIPS 203 ML-KEM-768) into a single
 * self-contained classic script safe for importScripts() in MV3 service workers.
 *
 * Run this ONCE after cloning, then reload the extension.
 *
 * Usage:
 *   npm install mlkem esbuild
 *   node build-pqc.js
 *
 * Output:
 *   src/vendor/mlkem768.js   (~50KB, replaces the stub)
 *
 * The bundle exposes globalThis.MLKEM768 = { MlKem768 }
 * background-bundle.js detects this and enables V2 (hybrid) mode automatically.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUT = path.join(__dirname, 'src', 'vendor', 'mlkem768.js');
const STUB = path.join(__dirname, 'src', 'vendor', 'mlkem768-stub.js');

console.log('\nCryptoChat PQC builder\n');

// Check dependencies
for (const dep of ['mlkem', 'esbuild']) {
  try {
    require.resolve(dep);
    console.log(`  ✓ ${dep} found`);
  } catch (_) {
    console.error(`  ✗ ${dep} not found — run: npm install mlkem esbuild`);
    process.exit(1);
  }
}

console.log('\nBundling ML-KEM-768...');

// Write a tiny entry point that exposes MlKem768 as a global
const entry = path.join(__dirname, '_pqc_entry_tmp.js');
fs.writeFileSync(entry, `
import { MlKem768 } from 'mlkem';
globalThis.MLKEM768 = { MlKem768 };
`);

try {
  execSync(
    `npx esbuild ${entry} ` +
    `--bundle ` +
    `--format=iife ` +
    `--platform=browser ` +
    `--target=chrome100,firefox109 ` +
    `--minify ` +
    `--outfile=${OUT}`,
    { stdio: 'inherit' }
  );

  fs.unlinkSync(entry);

  // Prepend a note to the bundle
  const bundle = fs.readFileSync(OUT, 'utf8');
  const header = `/**
 * mlkem768.js — ML-KEM-768 (NIST FIPS 203)
 * Bundled from: https://www.npmjs.com/package/mlkem
 * Build: node build-pqc.js
 * DO NOT EDIT — regenerate with build-pqc.js
 */\n`;
  fs.writeFileSync(OUT, header + bundle);

  const sizeKB = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`\n✓ Written: src/vendor/mlkem768.js (${sizeKB} KB)`);
  console.log('✓ Post-quantum encryption enabled.');
  console.log('\nNext steps:');
  console.log('  1. node build.js pack   — rebuild Chrome + Firefox packages');
  console.log('  2. Reload the extension in your browser');
  console.log('  3. New identities will include an ML-KEM-768 public key');
  console.log('  4. Messages to contacts with ML-KEM keys use V2 hybrid encryption\n');

} catch (err) {
  fs.existsSync(entry) && fs.unlinkSync(entry);
  console.error('\nBuild failed:', err.message);
  process.exit(1);
}
