'use strict';

const ACTIVE_STATES = new Set(['running', 'paused']);

/**
 * Compares two decoded statuses and returns the Flow events to fire.
 * Without a previous status (first message after app start) nothing fires,
 * so restarting the app during a wash does not trigger "Program started".
 *
 * @returns {Array<{ type: 'started'|'finished'|'phase' }>}
 */
function detectEvents(prev, next) {
  if (!prev) return [];
  const events = [];
  const wasActive = ACTIVE_STATES.has(prev.state);

  if (next.state === 'running' && !wasActive) {
    events.push({ type: 'started' });
  }

  if (next.phase !== prev.phase && next.phase !== 'none') {
    events.push({ type: 'phase' });
  }

  // Finished: the machine reports "remove laundry", or a running programme
  // stops without passing through that phase (also covers a cancelled programme)
  const reachedFinishedPhase = next.phase === 'finished' && prev.phase !== 'finished'
    && (wasActive || ACTIVE_STATES.has(next.state));
  const stoppedRunning = wasActive && !ACTIVE_STATES.has(next.state)
    && next.state !== 'unknown' && prev.phase !== 'finished' && next.phase !== 'finished';
  if (reachedFinishedPhase || stoppedRunning) {
    events.push({ type: 'finished' });
  }

  return events;
}

module.exports = { detectEvents };
