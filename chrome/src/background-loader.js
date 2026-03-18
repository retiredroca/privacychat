/**
 * background-loader.js
 *
 * Classic (non-module) service worker entry point.
 * importScripts() is the only way to load multiple files in MV3 service workers
 * that work in BOTH Chrome and Firefox without type:module.
 *
 * Load order:
 *  1. mlkem768.js (or stub)  — sets globalThis.MLKEM768
 *  2. background-bundle.js   — engine + keystore + message handler
 *     Reads MLKEM768: if null → V1 mode (ECDH only)
 *                     if set  → V2 mode (hybrid ECDH + ML-KEM-768)
 */

// Try real ML-KEM bundle first, fall back to stub automatically.
// Both set globalThis.MLKEM768 (null for stub, object for real).
try {
  importScripts('vendor/mlkem768.js');
} catch (_) {
  importScripts('vendor/mlkem768-stub.js');
}

importScripts('background-bundle.js');
