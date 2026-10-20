'use strict';

/*
 * HomeWhiz BLE protocol, ported from the Home Assistant integration
 * (github.com/rowysock/home-assistant-HomeWhiz, custom_components/homewhiz/bluetooth.py).
 *
 * - Machines advertise with a local name starting with "HwZ".
 * - Notifications arrive on characteristic 0000ac02-..., commands are written to 0000ac01-...
 * - After subscribing, the integration writes 02 04 00 04 00 1a 01 03 once to start the status stream.
 * - A status message is split over two notifications. Byte 4 of each notification is the
 *   frame index (0 or 1); the payload starts at byte 7. Notifications shorter than 10 bytes are ignored.
 * - In the assembled message, the high bit of a byte is a flag; the value is byte & 0x7f.
 */

const NOTIFY_CHARACTERISTIC = 'ac02';
const WRITE_CHARACTERISTIC = 'ac01';
const INIT_COMMAND = Buffer.from([0x02, 0x04, 0x00, 0x04, 0x00, 0x1a, 0x01, 0x03]);
const LOCAL_NAME_PREFIX = 'HwZ';

const FRAME_INDEX_OFFSET = 4;
const FRAME_PAYLOAD_OFFSET = 7;
const MIN_FRAME_LENGTH = 10;

/**
 * Matches a characteristic or service UUID regardless of how Homey formats it
 * ("ac02", "0000ac02-0000-1000-8000-00805f9b34fb" or the same without dashes).
 */
function isShortUuid(uuid, short) {
  const normalized = String(uuid).toLowerCase().replace(/-/g, '');
  return normalized === short || (normalized.length === 32 && normalized.slice(4, 8) === short);
}

function looksLikeHomeWhiz(advertisement) {
  return typeof advertisement.localName === 'string'
    && advertisement.localName.startsWith(LOCAL_NAME_PREFIX);
}

function toHex(buffer) {
  return Buffer.from(buffer).toString('hex').replace(/(..)(?!$)/g, '$1 ');
}

class MessageAccumulator {

  constructor(log = () => {}) {
    this._log = log;
    this._expectedIndex = 0;
    this._accumulated = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} frame one BLE notification
   * @returns {{ index: number, message: Buffer|null, ignored?: string }}
   */
  push(frame) {
    if (frame.length < MIN_FRAME_LENGTH) {
      return { index: -1, message: null, ignored: 'short' };
    }
    const index = frame[FRAME_INDEX_OFFSET];
    const payload = frame.subarray(FRAME_PAYLOAD_OFFSET);

    if (index === 0) {
      this._accumulated = Buffer.from(payload);
      this._expectedIndex = 1;
      return { index, message: null };
    }
    if (index === 1 && this._expectedIndex === 1) {
      const message = Buffer.concat([this._accumulated, payload]);
      this._expectedIndex = 0;
      this._accumulated = Buffer.alloc(0);
      return { index, message };
    }
    // Unexpected sequence: reset so we don't get stuck
    this._log(`Unexpected frame index ${index} (expected ${this._expectedIndex}), resetting`);
    this._expectedIndex = 0;
    this._accumulated = Buffer.alloc(0);
    return { index, message: null, ignored: 'sequence' };
  }

}

module.exports = {
  NOTIFY_CHARACTERISTIC,
  WRITE_CHARACTERISTIC,
  INIT_COMMAND,
  LOCAL_NAME_PREFIX,
  MessageAccumulator,
  isShortUuid,
  looksLikeHomeWhiz,
  toHex,
};
