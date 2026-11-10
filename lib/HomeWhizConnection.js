'use strict';

const { EventEmitter } = require('events');
const {
  NOTIFY_CHARACTERISTIC,
  WRITE_CHARACTERISTIC,
  INIT_COMMAND,
  isShortUuid,
  toHex,
} = require('./protocol');

const DEFAULT_TIMING = {
  // Retry delays while the machine is absent (it is switched off most of the time)
  retryDelays: [5000, 15000, 30000, 60000],
  // Limit for every BLE step, so a call Homey never answers cannot stall the connect loop
  stepTimeout: 30000,
  settleDelay: 500,
  // Without any frame for this long, the init command is resent as a liveness probe;
  // the machine always answers it. No answer within probeTimeout means the link is dead.
  silenceBeforeProbe: 5 * 60 * 1000,
  probeTimeout: 30000,
  // How often the supervisor checks that a connection or a pending attempt exists
  supervisorInterval: 60000,
};

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

  constructor({
    homey, peripheralUuid, log, debug, timing = {},
  }) {
    super();
    this.homey = homey;
    this.timing = { ...DEFAULT_TIMING, ...timing };
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
    this._busySince = 0;
    this._lastFrameAt = 0;
    this._probeSentAt = 0;
    this._supervisor = null;
  }

  get isConnected() {
    return this._peripheral !== null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._schedule(0);
    this._supervisor = this.homey.setInterval(() => {
      this._supervise().catch((err) => this.log('Unexpected error in supervisor:', err));
    }, this.timing.supervisorInterval);
  }

  async stop() {
    this._running = false;
    this.homey.clearTimeout(this._timer);
    this.homey.clearInterval(this._supervisor);
    this._timer = null;
    this._supervisor = null;
    const peripheral = this._peripheral;
    this._peripheral = null;
    if (peripheral) {
      await peripheral.disconnect().catch(() => {});
    }
  }

  async write(data) {
    if (!this._writeCharacteristic) throw new Error('Not connected');
    this.debug(`TX ${toHex(data)}`);
    return withTimeout(this._writeCharacteristic.write(data), this.timing.stepTimeout, 'write');
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
    const delays = this.timing.retryDelays;
    const delay = delays[Math.min(this._attempt, delays.length - 1)];
    this._attempt += 1;
    this.debug(`Next connection attempt in ${delay / 1000} s`);
    this._schedule(delay);
  }

  async _tryConnect() {
    if (!this._running || this._busy || this._peripheral) return;
    this._busy = true;
    this._busySince = Date.now();
    let peripheral = null;
    try {
      this.debug(`Connection attempt ${this._attempt + 1}: looking for ${this.peripheralUuid}`);
      const advertisement = await this._findAdvertisement();
      this.debug(`Found ${advertisement.localName} rssi=${advertisement.rssi} connectable=${advertisement.connectable}`);

      const { stepTimeout } = this.timing;
      peripheral = await withTimeout(advertisement.connect(), stepTimeout, 'connect');
      const services = await withTimeout(
        peripheral.discoverAllServicesAndCharacteristics(), stepTimeout, 'service discovery',
      );
      const { notify, write } = this._findCharacteristics(services);

      // The HA integration waits briefly before subscribing; kept here untested as well
      await sleep(this.timing.settleDelay);
      await withTimeout(
        notify.subscribeToNotifications((data) => this._onFrame(peripheral, data)), stepTimeout, 'subscribe',
      );
      this.debug(`TX ${toHex(INIT_COMMAND)} (init)`);
      await withTimeout(write.write(INIT_COMMAND), stepTimeout, 'init write');

      if (!this._running) {
        await peripheral.disconnect().catch(() => {});
        return;
      }

      this._peripheral = peripheral;
      this._writeCharacteristic = write;
      this._lastFrameAt = Date.now();
      this._probeSentAt = 0;
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
    const { stepTimeout } = this.timing;
    try {
      return await withTimeout(this.homey.ble.find(this.peripheralUuid), stepTimeout, 'find');
    } catch (err) {
      // find() only looks in Homey's recent scan results; do a fresh scan once and retry
      this.debug(`find() failed (${err.message}), scanning`);
      await withTimeout(this.homey.ble.discover(), stepTimeout, 'discover');
      return withTimeout(this.homey.ble.find(this.peripheralUuid), stepTimeout, 'find');
    }
  }

  _onFrame(peripheral, data) {
    if (peripheral !== this._peripheral && this._peripheral !== null) return; // stale connection
    this._lastFrameAt = Date.now();
    this._probeSentAt = 0;
    this.emit('frame', Buffer.from(data));
  }

  /**
   * Runs every supervisorInterval. Repairs the two ways the loop can die silently:
   * no connection and no attempt pending, or a connection that no longer delivers anything.
   */
  async _supervise() {
    if (!this._running) return;
    const now = Date.now();

    if (this._busy) {
      // Every step has a timeout, so this only catches something unforeseen
      if (now - this._busySince > this.timing.stepTimeout * 6) {
        this.log('Connection attempt stuck, starting over');
        this._busy = false;
        this._scheduleRetry();
      }
      return;
    }

    if (!this._peripheral) {
      if (!this._timer) {
        this.log('No connection attempt pending, starting one');
        this._schedule(0);
      }
      return;
    }

    if (this._probeSentAt) {
      if (now - this._probeSentAt > this.timing.probeTimeout) {
        this.log('No answer from the machine, reconnecting');
        await this._dropConnection();
      }
      return;
    }

    if (now - this._lastFrameAt > this.timing.silenceBeforeProbe) {
      this.debug('No data for a while, probing the connection');
      this._probeSentAt = now;
      try {
        await this.write(INIT_COMMAND);
      } catch (err) {
        this.log(`Probe failed (${err.message}), reconnecting`);
        await this._dropConnection();
      }
    }
  }

  async _dropConnection() {
    const peripheral = this._peripheral;
    if (!peripheral) return;
    this._onDisconnect(peripheral);
    await withTimeout(peripheral.disconnect(), this.timing.stepTimeout, 'disconnect').catch(() => {});
  }

  _findCharacteristics(services) {
    let notify = null;
    let write = null;
    for (const service of services) {
      for (const characteristic of service.characteristics || []) {
        this.debug(`GATT service ${service.uuid} characteristic ${characteristic.uuid}`);
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
    this._probeSentAt = 0;
    this.log('Disconnected');
    this.emit('disconnected');
    this._attempt = 0;
    this._scheduleRetry();
  }

}

module.exports = HomeWhizConnection;
