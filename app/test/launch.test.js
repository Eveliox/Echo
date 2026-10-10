import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRevealApp } from '../src/launch.js';

test('logo holds briefly, then reveals ready content', () => {
  assert.equal(shouldRevealApp({ elapsedMs: 899, assetsReady: true, emergency: false }), false);
  assert.equal(shouldRevealApp({ elapsedMs: 900, assetsReady: true, emergency: false }), true);
});
test('a stalled asset never holds the app indefinitely', () => {
  assert.equal(shouldRevealApp({ elapsedMs: 900, assetsReady: false, emergency: false }), false);
  assert.equal(shouldRevealApp({ elapsedMs: 1800, assetsReady: false, emergency: false }), true);
});
test('an emergency bypasses the introduction immediately, even before assets load', () => {
  assert.equal(shouldRevealApp({ elapsedMs: 0, assetsReady: false, emergency: true }), true);
});

test('time behind the native loader cannot consume the visible logo pause', () => {
  assert.equal(shouldRevealApp({ elapsedMs: 5000, assetsReady: true, emergency: false, nativeHidden: false }), false);
  assert.equal(shouldRevealApp({ elapsedMs: 0, assetsReady: true, emergency: false, nativeHidden: true }), false);
  assert.equal(shouldRevealApp({ elapsedMs: 900, assetsReady: true, emergency: false, nativeHidden: true }), true);
  assert.equal(shouldRevealApp({ elapsedMs: 0, assetsReady: false, emergency: true, nativeHidden: false }), true);
});
