'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planStateCommand } = require('../lib/washerCommands');
const { INIT_COMMAND } = require('../lib/protocol');

const status = (state, remoteControl = true) => ({ state, remoteControl });
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};

test('init command keeps its original bytes', () => {
  assert.strictEqual(INIT_COMMAND.toString('hex'), '020400040' + '01a0103');
});

test('start from on or paused writes state 30 to index 34', () => {
  for (const state of ['on', 'paused']) {
    const plan = planStateCommand(status(state), 'start');
    assert.strictEqual(plan.target, 'running');
    assert.strictEqual(plan.command.toString('hex'), '02040004002201' + '1e');
  }
});

test('pause from running or delayed writes state 40 to index 34', () => {
  for (const state of ['running', 'delayed']) {
    const plan = planStateCommand(status(state), 'pause');
    assert.strictEqual(plan.target, 'paused');
    assert.strictEqual(plan.command.toString('hex'), '02040004002201' + '28');
  }
});

test('nothing is sent when the machine is already in the requested state', () => {
  assert.deepStrictEqual(planStateCommand(status('running', false), 'start'), { noop: true });
  assert.deepStrictEqual(planStateCommand(status('paused', false), 'pause'), { noop: true });
});

test('commands are refused without remote control, status or a valid transition', () => {
  assert.strictEqual(code(() => planStateCommand(null, 'start')), 'no_status');
  assert.strictEqual(code(() => planStateCommand(status('on', false), 'start')), 'remote_off');
  assert.strictEqual(code(() => planStateCommand(status('off'), 'start')), 'not_allowed_off');
  assert.strictEqual(code(() => planStateCommand(status('delayed'), 'start')), 'not_allowed_delayed');
  assert.strictEqual(code(() => planStateCommand(status('on'), 'pause')), 'not_allowed_on');
});
