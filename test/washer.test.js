'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MessageAccumulator } = require('../lib/protocol');
const { decodeWasher, programName } = require('../lib/washerModel');
const { detectEvents } = require('../lib/washerEvents');

const hex = (s) => Buffer.from(s.replace(/ /g, ''), 'hex');

// Frames received from the GWP696110W on 2026-10-20 (machine off, last programme Cottons 40 °C 1200 rpm)
const REAL_FRAME_0 = hex('02 04 3c 00 00 00 39 00 d4 c6 d5 ab 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 03 00 00 00 00 00 00 00 00 14 81 28 0c 00 00 00 00 80 01 22 01 22 80 80 00 00 00 00 00 00 00');
const REAL_FRAME_1 = hex('02 04 17 00 01 00 14 00 00 00 00 00 00 01 00 00 00 00 00 01 01 07 80 00 00 00 00');

function realMessage() {
  const acc = new MessageAccumulator();
  acc.push(REAL_FRAME_0);
  return acc.push(REAL_FRAME_1).message;
}

test('decodes the real message from the machine', () => {
  const status = decodeWasher(realMessage());
  assert.strictEqual(status.state, 'off');
  assert.strictEqual(status.on, false);
  assert.strictEqual(status.running, false);
  assert.strictEqual(status.programId, 1);
  assert.strictEqual(programName(status.programId, 'no'), 'Bomull');
  assert.strictEqual(programName(status.programId, 'en'), 'Cottons');
  assert.strictEqual(status.temperature, 40);
  assert.strictEqual(status.spin, 1200);
  assert.strictEqual(status.durationMinutes, 94);
  assert.strictEqual(status.remainingMinutes, 0, 'remaining time is 0 while off');
  assert.strictEqual(status.phase, 'none');
  assert.deepStrictEqual(status.warnings, { doorOpen: false, noWater: false, security: false });
});

test('remaining time is reported while running', () => {
  const message = realMessage();
  message[35] = 30; // running
  message[50] = 1; // washing
  const status = decodeWasher(message);
  assert.strictEqual(status.running, true);
  assert.strictEqual(status.remainingMinutes, 94);
  assert.strictEqual(status.phase, 'washing');
});

test('unknown programme falls back to its number', () => {
  assert.strictEqual(programName(16, 'no'), 'Program 16');
});

const s = (state, phase = 'none') => ({ state, phase });
const types = (prev, next) => detectEvents(prev, next).map((e) => e.type);

test('no events on the first message', () => {
  assert.deepStrictEqual(types(null, s('running', 'washing')), []);
});

test('program started fires from on/off/delayed but not when resuming', () => {
  assert.deepStrictEqual(types(s('on'), s('running')), ['started']);
  assert.deepStrictEqual(types(s('delayed', 'delay'), s('running', 'delay')), ['started']);
  assert.deepStrictEqual(types(s('paused', 'paused'), s('running', 'paused')), []);
});

test('phase changes fire, except back to none', () => {
  assert.deepStrictEqual(types(s('running', 'washing'), s('running', 'rinsing')), ['phase']);
  assert.deepStrictEqual(types(s('running', 'spin'), s('running', 'none')), []);
});

test('finished fires once, either via the finished phase or when the programme stops', () => {
  assert.deepStrictEqual(types(s('running', 'spin'), s('running', 'finished')), ['phase', 'finished']);
  assert.deepStrictEqual(types(s('running', 'finished'), s('on', 'finished')), []);
  assert.deepStrictEqual(types(s('on', 'finished'), s('off', 'none')), []);
  assert.deepStrictEqual(types(s('running', 'spin'), s('on', 'none')), ['finished']);
  assert.deepStrictEqual(types(s('on'), s('off')), []);
});
