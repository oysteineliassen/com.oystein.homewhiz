'use strict';

const Homey = require('homey');
const HomeWhizConnection = require('../../lib/HomeWhizConnection');
const { MessageAccumulator, toHex } = require('../../lib/protocol');
const { PROGRAMS, decodeWasher, programName } = require('../../lib/washerModel');
const { detectEvents } = require('../../lib/washerEvents');
const { CommandError, planStateCommand, planProgramCommands } = require('../../lib/washerCommands');

// The machine can flick through phases within a few seconds (seen: rinsing -> spin -> softener
// in 5 s), so "Phase changed" fires only once a phase has lasted this long
const PHASE_SETTLE_MS = 10000;

// How long to wait for the machine to report the requested state after a command
const COMMAND_TIMEOUT_MS = 15000;

class WasherDevice extends Homey.Device {

  async onInit() {
    const { peripheralUuid, localName } = this.getStore();
    this.log(`Init ${localName} (${peripheralUuid})`);

    // Devices paired with an older version lack the newer capabilities
    for (const capability of this.driver.manifest.capabilities) {
      if (!this.hasCapability(capability)) await this.addCapability(capability).catch(this.error);
    }
    // Replaced by the washer_program_select picker in 0.6.0
    if (this.hasCapability('washer_program')) await this.removeCapability('washer_program').catch(this.error);

    this._debugRaw = this.getSetting('debug_raw') !== false;
    this._lastMessageHex = null;
    this._status = null;
    this._phaseTimer = null;
    this._lastTriggeredPhase = null;
    this._waiters = [];
    this._accumulator = new MessageAccumulator((msg) => this.log(msg));

    this.connection = new HomeWhizConnection({
      homey: this.homey,
      peripheralUuid,
      log: (...args) => this.log(...args),
      debug: (...args) => { if (this._debugRaw) this.log('[debug]', ...args); },
    });
    this.connection.on('connected', () => {
      this._accumulator = new MessageAccumulator((msg) => this.log(msg));
      this._lastMessageHex = null;
      this.setCapabilityValue('homewhiz_connected', true).catch(this.error);
    });
    this.connection.on('disconnected', () => {
      this.setCapabilityValue('homewhiz_connected', false).catch(this.error);
    });
    this.connection.on('frame', (frame) => this._onFrame(frame));

    this.registerCapabilityListener('washer_start', () => this.sendStateCommand('start'));
    this.registerCapabilityListener('washer_pause', () => this.sendStateCommand('pause'));
    this.registerCapabilityListener('washer_program_select', async (value) => {
      try {
        await this.selectProgram({ programId: Number(value) });
      } catch (err) {
        // Show the machine's actual programme again instead of the rejected choice
        const current = this._status && PROGRAMS[this._status.programId] ? String(this._status.programId) : null;
        this.homey.setTimeout(() => this.setCapabilityValue('washer_program_select', current).catch(this.error), 500);
        throw err;
      }
    });

    await this.setCapabilityValue('homewhiz_connected', false).catch(this.error);
    this.connection.start();
  }

  isRemoteControlEnabled() {
    return Boolean(this._status && this._status.remoteControl);
  }

  /**
   * Sends start or pause and waits until the machine reports the new state.
   * @param {'start'|'pause'} action
   */
  async sendStateCommand(action) {
    const plan = this._plan(action, () => planStateCommand(this._status, action));
    if (plan.noop) {
      this.log(`Command ${action}: already ${this._status.state}`);
      return;
    }

    this.log(`Command ${action}: ${this._status.state} -> ${plan.target}`);
    await this._writeAndConfirm(plan.command, (status) => status.state === plan.target, action);
  }

  /**
   * Selects a programme, then temperature and spin. Each write waits for the machine
   * to report the new value, since changing the programme resets the other settings.
   * @param {{ programId: number, temperature?: number, spin?: number|string }} request
   */
  async selectProgram(request) {
    const writes = this._plan('select', () => planProgramCommands(this._status, request));
    this.log(`Command select: ${JSON.stringify(request)}`);
    for (const { field, expected, command } of writes) {
      await this._writeAndConfirm(command, (status) => status[field] === expected, `select ${field}=${expected}`);
    }
  }

  _plan(action, plan) {
    try {
      if (!this.connection.isConnected) throw new CommandError('not_connected');
      return plan();
    } catch (err) {
      if (err instanceof CommandError) {
        this.log(`Command ${action} refused: ${err.code}`);
        throw new Error(this.homey.__(`errors.${err.code}`));
      }
      throw err;
    }
  }

  async _writeAndConfirm(command, predicate, description) {
    if (this._status && predicate(this._status)) return;
    const confirmed = this._waitFor(predicate, COMMAND_TIMEOUT_MS);
    await this.connection.write(command);
    if (!await confirmed) {
      this.log(`Command ${description}: not confirmed within ${COMMAND_TIMEOUT_MS / 1000} s`);
      throw new Error(this.homey.__('errors.no_response'));
    }
  }

  _waitFor(predicate, timeout) {
    return new Promise((resolve) => {
      const waiter = { predicate, resolve };
      waiter.timer = this.homey.setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeout);
      this._waiters.push(waiter);
    });
  }

  isRunning() {
    return Boolean(this._status && this._status.running);
  }

  _onFrame(frame) {
    const { index, message, ignored } = this._accumulator.push(frame);
    if (this._debugRaw) {
      this.log(`RX frame idx=${index} len=${frame.length}${ignored ? ` (ignored: ${ignored})` : ''}: ${toHex(frame)}`);
    }
    if (!message) return;

    const hex = toHex(message);
    // The machine repeats identical status messages; only handle changes
    if (hex === this._lastMessageHex) return;
    this._lastMessageHex = hex;

    const status = decodeWasher(message);
    this.log(`MSG ${hex}`);
    this.log(`Status: state=${status.state}(${status.stateRaw}) program=${status.programId} temp=${status.temperature} spin=${status.spin}`
      + ` remaining=${status.remainingMinutes}min phase=${status.phase}(${status.phaseRaw})`
      + ` doorLocked=${status.doorLocked} warnings=${JSON.stringify(status.warnings)} remote=${status.remoteControl}`);
    this._applyStatus(status).catch(this.error);
  }

  async _applyStatus(status) {
    const prev = this._status;
    this._status = status;
    const program = programName(status.programId, this.homey.i18n.getLanguage());

    await Promise.all([
      this._set('washer_state', status.state),
      this._set('washer_on', status.on),
      // null for programme numbers outside the configuration (e.g. 0 while off)
      this._set('washer_program_select', PROGRAMS[status.programId] ? String(status.programId) : null),
      this._set('washer_phase', status.phase),
      this._set('washer_remaining', status.remainingMinutes),
      this._set('washer_temperature', status.temperature),
      this._set('washer_spin', status.spin),
      this._set('washer_door_locked', status.doorLocked),
      this._set('washer_remote_control', status.remoteControl),
    ]);

    const satisfied = this._waiters.filter((w) => w.predicate(status));
    this._waiters = this._waiters.filter((w) => !satisfied.includes(w));
    for (const waiter of satisfied) {
      this.homey.clearTimeout(waiter.timer);
      waiter.resolve(true);
    }

    for (const event of detectEvents(prev, status)) {
      this.log(`Flow trigger: ${event.type}`);
      if (event.type === 'started') {
        await this.driver.programStartedTrigger.trigger(this, {
          program,
          temperature: status.temperature,
          spin: status.spin,
          remaining: status.remainingMinutes,
        }).catch(this.error);
      } else if (event.type === 'phase') {
        this._schedulePhaseTrigger();
      } else if (event.type === 'finished') {
        await this.driver.finishedTrigger.trigger(this, { program }).catch(this.error);
      }
    }
  }

  _schedulePhaseTrigger() {
    this.homey.clearTimeout(this._phaseTimer);
    this._phaseTimer = this.homey.setTimeout(() => {
      this._phaseTimer = null;
      const { phase } = this._status;
      if (phase === this._lastTriggeredPhase || phase === 'none' || phase === 'unknown') return;
      this._lastTriggeredPhase = phase;
      this.log(`Flow trigger: phase changed to ${phase}`);
      this.driver.phaseChangedTrigger.trigger(this, {
        phase: this.homey.__(`phase.${phase}`),
        phase_id: phase,
      }).catch(this.error);
    }, PHASE_SETTLE_MS);
  }

  async _set(capability, value) {
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  async onSettings({ changedKeys, newSettings }) {
    if (changedKeys.includes('debug_raw')) {
      this._debugRaw = newSettings.debug_raw;
    }
  }

  async onUninit() {
    this.homey.clearTimeout(this._phaseTimer);
    if (this.connection) await this.connection.stop();
  }

  async onDeleted() {
    this.homey.clearTimeout(this._phaseTimer);
    if (this.connection) await this.connection.stop();
  }

}

module.exports = WasherDevice;
