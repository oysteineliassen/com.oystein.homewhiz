'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  MessageAccumulator, annotateWasherMessage, byteValue, isShortUuid, WASHER_DEBUG_LAYOUT,
} = require('../lib/protocol');

// Assembled status message from the HA integration's test_washing_machine.py (test_on):
// state ON, Cottons, 30 °C, 1200 rpm, 2 h 17 min remaining
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

test('tentative washer layout matches HA test vector', () => {
  const v = (key) => byteValue(HA_TEST_ON, WASHER_DEBUG_LAYOUT[key]);
  assert.strictEqual(v('state'), 10); // DEVICE_STATE_ON
  assert.strictEqual(v('program'), 1); // PROGRAM_COTTONS
  assert.strictEqual(v('temperature'), 30);
  assert.strictEqual(v('spin'), 12); // x100 rpm
  assert.strictEqual(v('remainingHour') * 60 + v('remainingMinute'), 137);
  assert.match(annotateWasherMessage(HA_TEST_ON), /state=10 program=1 temp=30 spin=12 remaining=2h17m/);
});

test('matches characteristic UUIDs in any Homey format', () => {
  assert.ok(isShortUuid('ac02', 'ac02'));
  assert.ok(isShortUuid('0000ac02-0000-1000-8000-00805f9b34fb', 'ac02'));
  assert.ok(isShortUuid('0000AC0200001000800000805F9B34FB', 'ac02'));
  assert.ok(!isShortUuid('0000ac01-0000-1000-8000-00805f9b34fb', 'ac02'));
});
