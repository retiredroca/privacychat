/**
 * mlkem768-stub.js
 *
 * Placeholder loaded by importScripts() BEFORE background-bundle.js.
 * Sets globalThis.MLKEM768 = null to signal "ML-KEM not available".
 *
 * To enable post-quantum encryption:
 *   1. npm install mlkem esbuild
 *   2. node build-pqc.js
 *   This replaces this file with src/vendor/mlkem768.js — a real bundle.
 *
 * While this stub is present, CryptoChat operates in V1 mode (ECDH P-256 only).
 * All existing messages continue to work. No data is lost.
 * Once the real bundle is installed and both parties have ML-KEM public keys,
 * new messages automatically upgrade to V2 (hybrid ECDH + ML-KEM-768).
 */

globalThis.MLKEM768 = null; // null = stub, object = real implementation
