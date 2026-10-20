'use strict';

const Homey = require('homey');
const { looksLikeHomeWhiz } = require('../../lib/protocol');

class WasherDriver extends Homey.Driver {

  async onInit() {
    this.finishedTrigger = this.homey.flow.getDeviceTriggerCard('washer_finished');
    this.programStartedTrigger = this.homey.flow.getDeviceTriggerCard('washer_program_started');
    this.phaseChangedTrigger = this.homey.flow.getDeviceTriggerCard('washer_phase_changed');
    this.homey.flow.getConditionCard('washer_is_running')
      .registerRunListener(async ({ device }) => device.isRunning());
    this.homey.flow.getConditionCard('washer_remote_control_enabled')
      .registerRunListener(async ({ device }) => device.isRemoteControlEnabled());
    this.homey.flow.getActionCard('washer_start')
      .registerRunListener(async ({ device }) => device.sendStateCommand('start'));
    this.homey.flow.getActionCard('washer_pause')
      .registerRunListener(async ({ device }) => device.sendStateCommand('pause'));
    this.log('Washer driver initialized');
  }

  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();
    this.log(`BLE scan found ${advertisements.length} devices`);
    for (const adv of advertisements) {
      this.log(`  ${adv.localName || '(no name)'} uuid=${adv.uuid} address=${adv.address} rssi=${adv.rssi} connectable=${adv.connectable} services=${JSON.stringify(adv.serviceUuids)}`);
    }

    const devices = advertisements
      .filter(looksLikeHomeWhiz)
      .map((adv) => ({
        name: `HomeWhiz ${adv.localName}`,
        data: { id: adv.uuid },
        store: {
          peripheralUuid: adv.uuid,
          address: adv.address,
          localName: adv.localName,
        },
      }));

    if (devices.length === 0) {
      throw new Error(this.homey.__('pair.no_devices'));
    }
    return devices;
  }

}

module.exports = WasherDriver;
