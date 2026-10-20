'use strict';

const Homey = require('homey');
const HomeWhizConnection = require('../../lib/HomeWhizConnection');
const { MessageAccumulator, toHex } = require('../../lib/protocol');
const { decodeWasher, programName } = require('../../lib/washerModel');
const { detectEvents } = require('../../lib/washerEvents');

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
      + ` warnings=${JSON.stringify(status.warnings)} remote=${status.remoteControl}`);
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
        await this.driver.phaseChangedTrigger.trigger(this, {
          phase: this.homey.__(`phase.${status.phase}`),
          phase_id: status.phase,
        }).catch(this.error);
      } else if (event.type === 'finished') {
        await this.driver.finishedTrigger.trigger(this, { program }).catch(this.error);
      }
    }
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
    if (this.connection) await this.connection.stop();
  }

  async onDeleted() {
    if (this.connection) await this.connection.stop();
  }

}

module.exports = WasherDevice;
