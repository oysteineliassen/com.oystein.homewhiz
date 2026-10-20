'use strict';

const Homey = require('homey');
const HomeWhizConnection = require('../../lib/HomeWhizConnection');
const { MessageAccumulator, toHex } = require('../../lib/protocol');
const { decodeWasher, programName } = require('../../lib/washerModel');
const { detectEvents } = require('../../lib/washerEvents');

// The machine can flick through phases within a few seconds (seen: rinsing -> spin -> softener
// in 5 s), so "Phase changed" fires only once a phase has lasted this long
const PHASE_SETTLE_MS = 10000;

class WasherDevice extends Homey.Device {

  async onInit() {
    const { peripheralUuid, localName } = this.getStore();
    this.log(`Init ${localName} (${peripheralUuid})`);

    // Devices paired with an older version lack the newer capabilities
    for (const capability of this.driver.manifest.capabilities) {
      if (!this.hasCapability(capability)) await this.addCapability(capability).catch(this.error);
    }

    this._debugRaw = this.getSetting('debug_raw') !== false;
    this._lastMessageHex = null;
    this._status = null;
    this._phaseTimer = null;
    this._lastTriggeredPhase = null;
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

    await this.setCapabilityValue('homewhiz_connected', false).catch(this.error);
    this.connection.start();
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
      this._set('washer_program', program),
      this._set('washer_phase', status.phase),
      this._set('washer_remaining', status.remainingMinutes),
      this._set('washer_temperature', status.temperature),
      this._set('washer_spin', status.spin),
      this._set('washer_door_locked', status.doorLocked),
    ]);

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
