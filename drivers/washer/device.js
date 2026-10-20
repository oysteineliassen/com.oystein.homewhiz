'use strict';

const Homey = require('homey');
const HomeWhizConnection = require('../../lib/HomeWhizConnection');
const { MessageAccumulator, annotateWasherMessage, toHex } = require('../../lib/protocol');

class WasherDevice extends Homey.Device {

  async onInit() {
    const { peripheralUuid, localName } = this.getStore();
    this.log(`Init ${localName} (${peripheralUuid})`);

    this._debugRaw = this.getSetting('debug_raw') !== false;
    this._lastMessageHex = null;
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

  _onFrame(frame) {
    const { index, message, ignored } = this._accumulator.push(frame);
    if (this._debugRaw) {
      this.log(`RX frame idx=${index} len=${frame.length}${ignored ? ` (ignored: ${ignored})` : ''}: ${toHex(frame)}`);
    }
    if (!message) return;

    const hex = toHex(message);
    // The machine repeats identical status messages; only log changes
    if (hex === this._lastMessageHex) return;
    this._lastMessageHex = hex;
    this.log(`MSG ${hex}`);
    this.log(`MSG decoded (tentative layout): ${annotateWasherMessage(message)}`);
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
