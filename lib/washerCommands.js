'use strict';

const { buildCommand } = require('./protocol');

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
function planStateCommand(status, action, { requireRemoteControl = true } = {}) {
  const { target, from } = ACTIONS[action];
  if (!status) throw new CommandError('no_status');
  if (status.state === target) return { noop: true };
  if (requireRemoteControl && !status.remoteControl) throw new CommandError('remote_off');
  if (!from.includes(status.state)) throw new CommandError(`not_allowed_${status.state}`);
  return { target, command: buildCommand(STATE_WRITE_INDEX, STATE_VALUES[target]) };
}

module.exports = { CommandError, planStateCommand };
