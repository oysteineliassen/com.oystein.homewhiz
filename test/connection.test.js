'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const HomeWhizConnection = require('../lib/HomeWhizConnection');

const TIMING = {
  retryDelays: [10],
  stepTimeout: 50,
  settleDelay: 0,
  silenceBeforeProbe: 100,
  probeTimeout: 50,
  supervisorInterval: 20,
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});

/**
 * A machine on a fake Homey BLE stack. `answers` decides whether the machine
 * replies to writes; `hangFind` makes the next find() calls never resolve.
 */
function setup({ answers = true, hangFind = 0 } = {}) {
  const machine = { connects: 0, answers, hangFind };
  const makePeripheral = () => {
    const peripheral = new EventEmitter();
    let onNotify = null;
    const notify = { uuid: '0000ac0200001000800000805f9b34fb', subscribeToNotifications: async (cb) => { onNotify = cb; } };
    const write = {
      uuid: '0000ac0100001000800000805f9b34fb',
      write: async () => {
        if (machine.answers) setTimeout(() => onNotify && onNotify(Buffer.from([2, 1, 0, 0])), 1);
      },
    };
    peripheral.discoverAllServicesAndCharacteristics = async () => [{ uuid: 'ac00', characteristics: [notify, write] }];
    peripheral.disconnect = async () => peripheral.emit('disconnect');
    return peripheral;
  };
  const homey = {
    setTimeout, clearTimeout, setInterval, clearInterval,
    ble: {
      find: async () => {
        if (machine.hangFind > 0) {
          machine.hangFind -= 1;
          return never();
        }
        return {
          localName: 'HwZ_test', address: '00:00', rssi: -70, connectable: true,
          connect: async () => { machine.connects += 1; return makePeripheral(); },
        };
      },
      discover: async () => [],
    },
  };
  const logs = [];
  const connection = new HomeWhizConnection({
    homey, peripheralUuid: 'test', timing: TIMING, log: (...a) => logs.push(a.join(' ')), debug: () => {},
  });
  return { machine, connection, logs };
}

test('a BLE call that never returns does not stall the connect loop', async () => {
  const { machine, connection } = setup({ hangFind: 2 });
  connection.start();
  await wait(300);
  assert.strictEqual(connection.isConnected, true);
  assert.strictEqual(machine.connects, 1);
  await connection.stop();
});

test('a silent dead connection is detected by the probe and replaced', async () => {
  const { machine, connection, logs } = setup();
  connection.start();
  await wait(30);
  assert.strictEqual(machine.connects, 1);
  machine.answers = false; // link dies without a disconnect event
  await wait(400);
  assert.ok(logs.some((l) => l.includes('No answer from the machine')), logs.join('\n'));
  assert.ok(machine.connects >= 2, `connects=${machine.connects}`);
  await connection.stop();
});

test('a quiet but healthy connection answers the probe and is kept', async () => {
  const { machine, connection, logs } = setup();
  connection.start();
  await wait(500);
  assert.strictEqual(machine.connects, 1);
  assert.ok(!logs.some((l) => l.includes('reconnecting')), logs.join('\n'));
  await connection.stop();
});

test('the supervisor restarts a loop with no connection and no pending attempt', async () => {
  const { machine, connection, logs } = setup();
  connection.start();
  await wait(30);
  // Simulate the broken state: connection gone without any retry scheduled
  connection._peripheral = null;
  connection.homey.clearTimeout(connection._timer);
  connection._timer = null;
  await wait(100);
  assert.ok(logs.some((l) => l.includes('No connection attempt pending')), logs.join('\n'));
  assert.strictEqual(machine.connects, 2);
  await connection.stop();
});
