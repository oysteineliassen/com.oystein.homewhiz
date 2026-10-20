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
  // Not in the cloud configuration. Observed 2026-10-20: the high bit is set a few
  // seconds after start and cleared when the programme ends, matching the lock icon
  doorLock: 63,
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
  // Not in the cloud configuration. Observed for ~10 s between "program started"
  // and "washing", while the door locks
  18: 'preparing',
  19: 'add_laundry',
  20: 'anticrease',
  21: 'drying',
};

// program.values: wifiArrayValue -> name (Norwegian names from HomeWhiz LOCALIZATION nb-NO)
const PROGRAMS = {
  1: { key: 'PROGRAM_COTTONS', en: 'Cottons', no: 'Bomull' },
  2: { key: 'PROGRAM_ECO_40_60', en: 'Eco 40-60', no: 'Øko 40–60' },
  3: { key: 'PROGRAM_SYNTHETICS', en: 'Synthetics', no: 'Syntetisk' },
  4: { key: 'PROGRAM_MINI_MINI14', en: 'Mini 14\'', no: 'Ekspress (Ekspress 14)' },
  5: { key: 'PROGRAM_WOOL_HANDWASH', en: 'Wool / Hand wash', no: 'Ull (håndvask)' },
  6: { key: 'PROGRAM_DARKWASH', en: 'Dark wash', no: 'Mørkt tøy (dongeribukser)' },
  7: { key: 'PROGRAM_MIX', en: 'Mix', no: 'Blanding' },
  8: { key: 'PROGRAM_SPIN_PUMP', en: 'Spin + Drain', no: 'Spin+pumpe' },
  9: { key: 'PROGRAM_RINSING', en: 'Rinse', no: 'Skyll' },
  10: { key: 'PROGRAM_OUTDOOR_SPORTS_GORETEX', en: 'Outdoor / Sports', no: 'Sport' },
  11: { key: 'PROGRAM_STAIN', en: 'Stain expert', no: 'Flekkfjerning' },
  12: { key: 'PROGRAM_HYGEINE', en: 'Hygiene+', no: 'Hygiene+' },
  13: { key: 'PROGRAM_DUVET', en: 'Duvet', no: 'Dyne' },
  14: { key: 'PROGRAM_SHIRTS', en: 'Shirts', no: 'Skjorter' },
  15: { key: 'PROGRAM_STEAM_REFRESH', en: 'Steam refresh', no: 'Oppfrisking med damp' },
  17: { key: 'PROGRAM_TOWEL', en: 'Towels', no: 'Håndkle' },
  18: { key: 'PROGRAM_SOFT_TOYS', en: 'Soft toys', no: 'Myke leker' },
  19: { key: 'PROGRAM_CURTAIN', en: 'Curtains', no: 'Gardiner' },
  41: { key: 'PROGRAM_DRUM_CLEAN', en: 'Drum clean', no: 'Trommelrengjøring' },
};

const SPIN_RINSE_HOLD = 17;

/*
 * Allowed temperatures and spin speeds per programme (subProgramOverrides.allowedValueIndices).
 * The indices point into the enum values followed by the bounded values of the feature:
 *   temperature: cold, 20, 30, 40 | 60, 90
 *   spin:        no spin, rinse hold | 600, 800, 1000, 1200, 1400, 1600
 * (Cottons allowing 1200 and Spin+Drain not allowing rinse hold confirm this order.)
 * null = the setting is disabled for that programme.
 */
const TEMPERATURE_VALUES = [0, 20, 30, 40, 60, 90];
const SPIN_VALUES = ['no_spin', 'rinse_hold', 600, 800, 1000, 1200, 1400, 1600];

const pick = (values, indices) => (indices === null ? null : indices.map((i) => values[i]));
const range = (n) => [...Array(n).keys()];

const PROGRAM_OPTIONS = Object.fromEntries(Object.entries({
  1: [range(6), [0, 1, 2, 3, 5, 7]],
  2: [[3, 4], [0, 2, 3, 5, 7]],
  3: [range(5), [0, 1, 2, 3, 5]],
  4: [range(6), [0, 1, 2, 3, 5]],
  5: [range(4), [0, 1, 2, 3, 5]],
  6: [range(4), [0, 1, 2, 3, 5]],
  7: [range(4), range(4)],
  8: [null, [0, 2, 3, 5, 7]],
  9: [null, [0, 1, 2, 3, 5, 7]],
  10: [range(4), [0, 1, 2, 3, 5]],
  11: [[2, 3, 4], [0, 1, 2, 3, 5, 7]],
  12: [[1, 2, 3, 4, 5], [0, 2, 3, 5, 7]],
  13: [range(5), range(4)],
  14: [range(5), range(4)],
  15: [null, null],
  17: [range(5), range(4)],
  18: [range(4), range(3)],
  19: [range(4), range(4)],
  41: [[5], [2]],
}).map(([id, [temps, spins]]) => [id, {
  temperatures: pick(TEMPERATURE_VALUES, temps),
  spins: pick(SPIN_VALUES, spins),
}]));

// Value written to the spin byte for a spin option
function spinByte(spin) {
  if (spin === 'no_spin') return 0;
  if (spin === 'rinse_hold') return SPIN_RINSE_HOLD;
  return spin / 100;
}

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
    doorLocked: INDEX.doorLock < message.length && (message[INDEX.doorLock] & 0x80) !== 0,
  };
}

module.exports = {
  INDEX,
  STATES,
  PHASES,
  PROGRAMS,
  PROGRAM_OPTIONS,
  decodeWasher,
  spinByte,
  programName,
};
