'use strict';

const { EventEmitter } = require('events');
const {
  NOTIFY_CHARACTERISTIC,
  WRITE_CHARACTERISTIC,
  INIT_COMMAND,
  isShortUuid,
  toHex,
} = require('./protocol');

// Retry delays while the machine is absent (it is switched off most of the time)
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];
const CONNECT_TIMEOUT_MS = 30000;
const SETTLE_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Keeps one BLE connection to a HomeWhiz machine alive.
 *
 * Emits:
 *  - 'connected'    (peripheral)
 *  - 'disconnected'
 *  - 'frame'        (Buffer) every raw notification
 *
 * Logging: state changes go to `log`; individual retry attempts only to `debug`,
 * so a machine that is off for days does not fill the log.
 */
class HomeWhizConnection extends EventEmitter {

  constructor({ homey, peripheralUuid, log, debug }) {
    super();
    this.homey = homey;
    this.peripheralUuid = peripheralUuid;
    this.log = log;
    this.debug = debug;

    this._peripheral = null;
    this._timer = null;
    this._attempt = 0;
    this._running = false;
    this._busy = false;
    this._reportedAbsent = false;
    this._lastError = null;
  }

  get isConnected() {
    return this._peripheral !== null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._schedule(0);
  }

  async stop() {
    this._running = false;
    this.homey.clearTimeout(this._timer);
    this._timer = null;
    const peripheral = this._peripheral;
    this._peripheral = null;
    if (peripheral) {
      await peripheral.disconnect().catch(() => {});
    }
  }

  async write(data) {
    if (!this._writeCharacteristic) throw new Error('Not connected');
    this.debug(`TX ${toHex(data)}`);
    return this._writeCharacteristic.write(data);
  }

  _schedule(delay) {
    if (!this._running) return;
    this.homey.clearTimeout(this._timer);
    this._timer = this.homey.setTimeout(() => {
      this._timer = null;
      this._tryConnect().catch((err) => this.log('Unexpected error in connect loop:', err));
    }, delay);
  }

  _scheduleRetry() {
    const delay = RETRY_DELAYS_MS[Math.min(this._attempt, RETRY_DELAYS_MS.length - 1)];
    this._attempt += 1;
    this.debug(`Next connection attempt in ${delay / 1000} s`);
    this._schedule(delay);
  }

  async _tryConnect() {
    if (!this._running || this._busy || this._peripheral) return;
    this._busy = true;
    let peripheral = null;
    try {
      this.debug(`Connection attempt ${this._attempt + 1}: looking for ${this.peripheralUuid}`);
      const advertisement = await this._findAdvertisement();
      this.debug(`Found ${advertisement.localName} rssi=${advertisement.rssi} connectable=${advertisement.connectable}`);

      peripheral = await withTimeout(advertisement.connect(), CONNECT_TIMEOUT_MS, 'connect');
      const services = await withTimeout(
        peripheral.discoverAllServicesAndCharacteristics(), CONNECT_TIMEOUT_MS, 'service discovery',
      );
      const { notify, write } = this._findCharacteristics(services);

      // The HA integration waits briefly before subscribing; kept here untested as well
      await sleep(SETTLE_DELAY_MS);
      await notify.subscribeToNotifications((data) => this.emit('frame', Buffer.from(data)));
      this.debug(`TX ${toHex(INIT_COMMAND)} (init)`);
      await write.write(INIT_COMMAND);

      if (!this._running) {
        await peripheral.disconnect().catch(() => {});
        return;
      }

      this._peripheral = peripheral;
      this._writeCharacteristic = write;
      peripheral.once('disconnect', () => this._onDisconnect(peripheral));

      this._attempt = 0;
      this._reportedAbsent = false;
      this._lastError = null;
      this.log(`Connected to ${advertisement.localName} (${advertisement.address}, rssi ${advertisement.rssi})`);
      this.emit('connected', peripheral);
    } catch (err) {
      if (peripheral) await peripheral.disconnect().catch(() => {});
      this._logFailure(err);
      this._scheduleRetry();
    } finally {
      this._busy = false;
    }
  }

  async _findAdvertisement() {
    try {
      return await this.homey.ble.find(this.peripheralUuid);
    } catch (err) {
      // find() only looks in Homey's recent scan results; do a fresh scan once and retry
      this.debug(`find() failed (${err.message}), scanning`);
      await this.homey.ble.discover();
      return this.homey.ble.find(this.peripheralUuid);
    }
  }

  _findCharacteristics(services) {
    let notify = null;
    let write = null;
    for (const service of services) {
      for (const characteristic of service.characteristics || []) {
        this.debug(`GATT service ${service.uuid} characteristic ${characteristic.uuid} props=${JSON.stringify(characteristic.properties)}`);
        if (isShortUuid(characteristic.uuid, NOTIFY_CHARACTERISTIC)) notify = characteristic;
        if (isShortUuid(characteristic.uuid, WRITE_CHARACTERISTIC)) write = characteristic;
      }
    }
    if (!notify || !write) {
      throw new Error(`HomeWhiz characteristics not found (ac02 ${notify ? 'ok' : 'missing'}, ac01 ${write ? 'ok' : 'missing'})`);
    }
    return { notify, write };
  }

  _logFailure(err) {
    const message = err && err.message ? err.message : String(err);
    if (!this._reportedAbsent) {
      this.log(`Machine not reachable (${message}). Retrying quietly in the background.`);
      this._reportedAbsent = true;
    } else if (message !== this._lastError) {
      this.debug(`Still not reachable: ${message}`);
    }
    this._lastError = message;
  }

  _onDisconnect(peripheral) {
    if (peripheral !== this._peripheral) return; // stale connection
    this._peripheral = null;
    this._writeCharacteristic = null;
    this.log('Disconnected');
    this.emit('disconnected');
    this._attempt = 0;
    this._scheduleRetry();
  }

}

module.exports = HomeWhizConnection;
