'use strict';

const ACTIVE_STATES = new Set(['running', 'paused']);

// A programme that stops with more time left than this was cancelled, not finished
const FINISHED_MAX_REMAINING_MINUTES = 2;

/**
 * Compares two decoded statuses and returns the Flow events to fire.
 * Without a previous status (first message after app start) nothing fires,
 * so restarting the app during a wash does not trigger "Program started".
 *
 * @returns {Array<{ type: 'started'|'finished'|'phase'|'warning', warning?: string }>}
 */
function detectEvents(prev, next) {
  if (!prev) return [];
  const events = [];
  const wasActive = ACTIVE_STATES.has(prev.state);
  const isActive = ACTIVE_STATES.has(next.state);

  if (next.state === 'running' && !wasActive) {
    events.push({ type: 'started' });
  }

  if (next.phase !== prev.phase && next.phase !== 'none') {
    events.push({ type: 'phase' });
  }

  // Observed on 2026-10-20: at the end the machine goes running -> on with 0 min left,
  // then reports "remove laundry"; a cancelled wash goes running -> off with time left
  const reachedFinishedPhase = next.phase === 'finished' && prev.phase !== 'finished'
    && (wasActive || isActive);
  const stoppedAtEnd = wasActive && !isActive && next.state !== 'unknown'
    && prev.remainingMinutes <= FINISHED_MAX_REMAINING_MINUTES
    && prev.phase !== 'finished' && next.phase !== 'finished';
  if (reachedFinishedPhase || stoppedAtEnd) {
    events.push({ type: 'finished' });
  }

  for (const [warning, active] of Object.entries(next.warnings || {})) {
    if (active && !(prev.warnings || {})[warning]) events.push({ type: 'warning', warning });
  }

  return events;
}

module.exports = { detectEvents };
