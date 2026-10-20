'use strict';

/*
 * Status layout for Grundig GWP696110W (product code 7177881300),
 * taken from the HomeWhiz cloud configuration CONFIGURATION_471 v18
 * (fetched once with tools/fetch-homewhiz-config.mjs).
 *
 * All indices refer to the assembled status message (see protocol.js).
 * Values are byte & 0x7f; the high bit is a flag.
 */

const INDEX = {
  remoteControl: 32, // 170 when remote control is enabled (read raw, without masking)
  state: 35,
  program: 36,
  temperature: 37,
  spin: 38,
  durationHour: 44,
  durationMinute: 45,
  remainingHour: 46,
  remainingMinute: 47,
  delayHour: 48,
  delayMinute: 49,
  phase: 50,
  warnings: 59,
};

const STATES = {
  10: 'on',
  20: 'off',
  30: 'running',
  40: 'paused',
  60: 'delayed',
};

// deviceSubStates
const PHASES = {
  0: 'none',
  1: 'washing',
  2: 'spin',
  3: 'water_intake',
  4: 'prewash',
  5: 'rinsing',
  6: 'softener',
  7: 'program_started',
  8: 'delay',
  9: 'paused',
  10: 'analysing',
  11: 'door_locked',
  12: 'opening_door',
  13: 'locking_door',
  15: 'finished', // WASHER_SUBSTATE_REMOVE_LAUNDRY
  17: 'rinse_hold',
  19: 'add_laundry',
  20: 'anticrease',
  21: 'drying',
};

// program.values: wifiArrayValue -> name
const PROGRAMS = {
  1: { key: 'PROGRAM_COTTONS', en: 'Cottons', no: 'Bomull' },
  2: { key: 'PROGRAM_ECO_40_60', en: 'Eco 40-60', no: 'Eco 40-60' },
  3: { key: 'PROGRAM_SYNTHETICS', en: 'Synthetics', no: 'Syntetisk' },
  4: { key: 'PROGRAM_MINI_MINI14', en: 'Mini 14\'', no: 'Mini 14\'' },
  5: { key: 'PROGRAM_WOOL_HANDWASH', en: 'Wool / Hand wash', no: 'Ull / Håndvask' },
  6: { key: 'PROGRAM_DARKWASH', en: 'Dark wash', no: 'Mørkt tøy' },
  7: { key: 'PROGRAM_MIX', en: 'Mix', no: 'Blandet' },
  8: { key: 'PROGRAM_SPIN_PUMP', en: 'Spin + Drain', no: 'Sentrifuge + tømming' },
  9: { key: 'PROGRAM_RINSING', en: 'Rinse', no: 'Skylling' },
  10: { key: 'PROGRAM_OUTDOOR_SPORTS_GORETEX', en: 'Outdoor / Sports', no: 'Friluft / Sport' },
  11: { key: 'PROGRAM_STAIN', en: 'Stain expert', no: 'Flekker' },
  12: { key: 'PROGRAM_HYGEINE', en: 'Hygiene+', no: 'Hygiene+' },
  13: { key: 'PROGRAM_DUVET', en: 'Duvet', no: 'Dyne' },
  14: { key: 'PROGRAM_SHIRTS', en: 'Shirts', no: 'Skjorter' },
  15: { key: 'PROGRAM_STEAM_REFRESH', en: 'Steam refresh', no: 'Dampoppfrisking' },
  17: { key: 'PROGRAM_TOWEL', en: 'Towels', no: 'Håndklær' },
  18: { key: 'PROGRAM_SOFT_TOYS', en: 'Soft toys', no: 'Kosedyr' },
  19: { key: 'PROGRAM_CURTAIN', en: 'Curtains', no: 'Gardiner' },
  41: { key: 'PROGRAM_DRUM_CLEAN', en: 'Drum clean', no: 'Trommelrens' },
};

const SPIN_RINSE_HOLD = 17;

function value(message, index) {
  return index < message.length ? message[index] & 0x7f : 0;
}

function programName(programId, language) {
  const program = PROGRAMS[programId];
  if (!program) return `Program ${programId}`;
  return program[language] || program.en;
}

/**
 * @param {Buffer} message assembled status message
 * @returns decoded washer status
 */
function decodeWasher(message) {
  const stateRaw = value(message, INDEX.state);
  const phaseRaw = value(message, INDEX.phase);
  const spinRaw = value(message, INDEX.spin);
  const warnings = value(message, INDEX.warnings);

  const state = STATES[stateRaw] || 'unknown';
  const phase = PHASES[phaseRaw] || 'unknown';
  const off = state === 'off';

  const remaining = value(message, INDEX.remainingHour) * 60 + value(message, INDEX.remainingMinute);

  return {
    state,
    stateRaw,
    on: !off && state !== 'unknown',
    running: state === 'running' || state === 'paused',
    programId: value(message, INDEX.program),
    temperature: value(message, INDEX.temperature), // 0 = cold wash
    spin: spinRaw === SPIN_RINSE_HOLD ? 0 : spinRaw * 100,
    rinseHold: spinRaw === SPIN_RINSE_HOLD,
    // The machine keeps reporting the last programme's time while off or finished
    remainingMinutes: off || phase === 'finished' ? 0 : remaining,
    durationMinutes: value(message, INDEX.durationHour) * 60 + value(message, INDEX.durationMinute),
    delayMinutes: value(message, INDEX.delayHour) * 60 + value(message, INDEX.delayMinute),
    phase,
    phaseRaw,
    warnings: {
      doorOpen: (warnings & 0b001) !== 0,
      noWater: (warnings & 0b010) !== 0,
      security: (warnings & 0b100) !== 0,
    },
    remoteControl: message[INDEX.remoteControl] === 170,
  };
}

module.exports = {
  INDEX,
  STATES,
  PHASES,
  PROGRAMS,
  decodeWasher,
  programName,
};
