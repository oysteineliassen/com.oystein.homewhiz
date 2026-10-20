'use strict';

const { buildCommand } = require('./protocol');
const { INDEX, PROGRAMS, PROGRAM_OPTIONS, spinByte } = require('./washerModel');

// deviceStates.wifiArrayWriteIndex and the state values from CONFIGURATION_471
const STATE_WRITE_INDEX = 34;
const STATE_VALUES = { running: 30, paused: 40 };

// allowedTransitions in the configuration, limited to start and pause
const ACTIONS = {
  start: { target: 'running', from: ['on', 'paused'] },
  pause: { target: 'paused', from: ['running', 'delayed'] },
};

class CommandError extends Error {

  constructor(code) {
    super(code);
    this.code = code;
  }

}

/**
 * Decides what to send for a start/pause request.
 * @returns {{ noop: true } | { target: string, command: Buffer }}
 * @throws {CommandError} code: no_status | remote_off | not_allowed_<state>
 */
function planStateCommand(status, action) {
  const { target, from } = ACTIONS[action];
  if (!status) throw new CommandError('no_status');
  if (status.state === target) return { noop: true };
  if (!status.remoteControl) throw new CommandError('remote_off');
  if (!from.includes(status.state)) throw new CommandError(`not_allowed_${status.state}`);
  return { target, command: buildCommand(STATE_WRITE_INDEX, STATE_VALUES[target]) };
}

/**
 * Plans the writes for selecting a programme, optionally with temperature and spin.
 * The machine must be on (not running) with remote control enabled.
 * @param {{ programId: number, temperature?: number, spin?: number|'no_spin'|'rinse_hold' }} request
 *   temperature/spin left undefined keep the programme's default.
 * @returns {Array<{ field: 'programId'|'temperature'|'spin', value: number, command: Buffer }>}
 * @throws {CommandError} no_status | remote_off | not_allowed_<state> | unknown_program |
 *   temperature_not_allowed | spin_not_allowed
 */
function planProgramCommands(status, { programId, temperature, spin }) {
  if (!status) throw new CommandError('no_status');
  if (!status.remoteControl) throw new CommandError('remote_off');
  if (status.state !== 'on') throw new CommandError(`not_allowed_${status.state}`);
  const options = PROGRAM_OPTIONS[programId];
  if (!PROGRAMS[programId] || !options) throw new CommandError('unknown_program');
  if (temperature !== undefined && !(options.temperatures || []).includes(temperature)) {
    throw new CommandError('temperature_not_allowed');
  }
  if (spin !== undefined && !(options.spins || []).includes(spin)) {
    throw new CommandError('spin_not_allowed');
  }

  const writes = [{ field: 'programId', index: INDEX.program, value: programId }];
  if (temperature !== undefined) writes.push({ field: 'temperature', index: INDEX.temperature, value: temperature });
  if (spin !== undefined) {
    // decodeWasher reports rinse hold and no spin both as 0 rpm
    const value = spinByte(spin);
    writes.push({ field: 'spin', index: INDEX.spin, value, expected: value === 17 ? 0 : value * 100 });
  }
  return writes.map(({ field, index, value, expected }) => ({
    field,
    expected: expected === undefined ? value : expected,
    command: buildCommand(index, value),
  }));
}

module.exports = { CommandError, planStateCommand, planProgramCommands };
