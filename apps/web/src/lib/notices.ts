import type { Notice, RoundState } from '@ajo/core';

/**
 * The coordinator's reminders that still apply: a reminder is about one round, so it goes away once that
 * round is complete or the member has paid it (or been marked as not paying it).
 */
export function activeNotices(notices: Notice[], rounds: Map<number, RoundState>, me: string): Notice[] {
  return notices.filter((n) => {
    const state = rounds.get(n.round);
    return !!state && state.status !== 'complete' && state.recipient !== me && !state.paid.includes(me) && !state.defaulted?.includes(me);
  });
}
