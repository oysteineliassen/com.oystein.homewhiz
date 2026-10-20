'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planStateCommand, planProgramCommands } = require('../lib/washerCommands');
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

const ready = { state: 'on', remoteControl: true };
const hexes = (writes) => writes.map((w) => w.command.toString('hex'));

test('select programme writes programme, temperature and spin to 36, 37 and 38', () => {
  const writes = planProgramCommands(ready, { programId: 1, temperature: 60, spin: 1200 });
  assert.deepStrictEqual(hexes(writes), ['02040004002401' + '01', '02040004002501' + '3c', '02040004002601' + '0c']);
  assert.deepStrictEqual(writes.map((w) => [w.field, w.expected]), [['programId', 1], ['temperature', 60], ['spin', 1200]]);
});

test('select programme without temperature and spin only writes the programme', () => {
  assert.deepStrictEqual(hexes(planProgramCommands(ready, { programId: 7 })), ['02040004002401' + '07']);
});

test('rinse hold and no spin use the enum byte values', () => {
  assert.strictEqual(planProgramCommands(ready, { programId: 1, spin: 'rinse_hold' })[1].command[7], 17);
  assert.strictEqual(planProgramCommands(ready, { programId: 1, spin: 'no_spin' })[1].command[7], 0);
});

test('select programme is refused for disallowed values and states', () => {
  assert.strictEqual(code(() => planProgramCommands(ready, { programId: 16 })), 'unknown_program');
  assert.strictEqual(code(() => planProgramCommands(ready, { programId: 2, temperature: 30 })), 'temperature_not_allowed');
  assert.strictEqual(code(() => planProgramCommands(ready, { programId: 7, spin: 1200 })), 'spin_not_allowed');
  assert.strictEqual(code(() => planProgramCommands(ready, { programId: 15, temperature: 40 })), 'temperature_not_allowed');
  assert.strictEqual(code(() => planProgramCommands({ ...ready, remoteControl: false }, { programId: 1 })), 'remote_off');
  assert.strictEqual(code(() => planProgramCommands({ ...ready, state: 'running' }, { programId: 1 })), 'not_allowed_running');
});
