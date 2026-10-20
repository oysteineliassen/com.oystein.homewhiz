'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MessageAccumulator, isShortUuid } = require('../lib/protocol');

// Status message from the HA integration's test_washing_machine.py (test_on)
const HA_TEST_ON = Buffer.from(
  '002f4a45a10100000000000000000000000000000000000000000200000000000000000a011e0c'
  + '0000000080021102110000000000000000000000000000000100000000000001070000000000',
  'hex',
);

function frame(index, payload) {
  const header = Buffer.from([0x00, 0x00, 0x00, 0x00, index, 0x00, 0x00]);
  return Buffer.concat([header, payload]);
}

test('assembles two frames into one message', () => {
  const acc = new MessageAccumulator();
  const half = 40;
  assert.strictEqual(acc.push(frame(0, HA_TEST_ON.subarray(0, half))).message, null);
  const { message } = acc.push(frame(1, HA_TEST_ON.subarray(half)));
  assert.deepStrictEqual(message, HA_TEST_ON);
});

test('ignores short frames and resets on unexpected index', () => {
  const acc = new MessageAccumulator();
  assert.strictEqual(acc.push(Buffer.alloc(9)).ignored, 'short');
  assert.strictEqual(acc.push(frame(1, Buffer.alloc(10))).ignored, 'sequence');
  acc.push(frame(0, Buffer.from([1, 2, 3])));
  assert.strictEqual(acc.push(frame(2, Buffer.alloc(10))).ignored, 'sequence');
  assert.strictEqual(acc.push(frame(1, Buffer.alloc(10))).ignored, 'sequence');
});

test('matches characteristic UUIDs in any Homey format', () => {
  assert.ok(isShortUuid('ac02', 'ac02'));
  assert.ok(isShortUuid('0000ac02-0000-1000-8000-00805f9b34fb', 'ac02'));
  assert.ok(isShortUuid('0000AC0200001000800000805F9B34FB', 'ac02'));
  assert.ok(!isShortUuid('0000ac01-0000-1000-8000-00805f9b34fb', 'ac02'));
});

module.exports = { HA_TEST_ON, frame };
