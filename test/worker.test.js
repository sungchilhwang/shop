import test from 'node:test';
import assert from 'node:assert/strict';
import { validId, validQty } from '../src/worker.js';

test('IDs accept positive integers only', () => {
  assert.equal(validId('1'), 1);
  assert.equal(validId('0'), null);
  assert.equal(validId('1.2'), null);
  assert.equal(validId('nope'), null);
});

test('quantities are limited to 1 through 99', () => {
  assert.equal(validQty(1), 1);
  assert.equal(validQty(99), 99);
  assert.equal(validQty(0), null);
  assert.equal(validQty(100), null);
  assert.equal(validQty('2.5'), null);
});
