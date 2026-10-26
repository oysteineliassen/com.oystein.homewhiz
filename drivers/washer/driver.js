'use strict';

const Homey = require('homey');
const { looksLikeHomeWhiz } = require('../../lib/protocol');

// Dropdown ids: 'default', 'no_spin', 'rinse_hold' or an rpm value
function parseSpin(spin) {
  if (spin === 'default') return undefined;
  if (spin === 'no_spin' || spin === 'rinse_hold') return spin;
  return Number(spin);
}

class WasherDriver extends Homey.Driver {

  async onInit() {
    this.finishedTrigger = this.homey.flow.getDeviceTriggerCard('washer_finished');
    this.programStartedTrigger = this.homey.flow.getDeviceTriggerCard('washer_program_started');
    this.phaseChangedTrigger = this.homey.flow.getDeviceTriggerCard('washer_phase_changed');
    this.warningTrigger = this.homey.flow.getDeviceTriggerCard('washer_warning');
    this.homey.flow.getConditionCard('washer_has_warning')
      .registerRunListener(async ({ device }) => device.hasWarning());
    this.homey.flow.getConditionCard('washer_is_running')
      .registerRunListener(async ({ device }) => device.isRunning());
    this.homey.flow.getConditionCard('washer_remote_control_enabled')
      .registerRunListener(async ({ device }) => device.isRemoteControlEnabled());
    this.homey.flow.getActionCard('washer_start')
      .registerRunListener(async ({ device }) => device.sendStateCommand('start'));
    this.homey.flow.getActionCard('washer_pause')
      .registerRunListener(async ({ device }) => device.sendStateCommand('pause'));
    this.homey.flow.getActionCard('washer_select_program')
      .registerRunListener(async ({
        device, program, temperature, spin,
      }) => device.selectProgram({
        programId: Number(program),
        temperature: temperature === 'default' ? undefined : Number(temperature),
        spin: parseSpin(spin),
      }));
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
        name: this.homey.__('pair.default_name'),
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
