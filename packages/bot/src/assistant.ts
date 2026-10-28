import { roundDeadline, unpaid, type GroupDef, type Language, type Notice, type Question, type RoundState } from '@ajo/core';
import type { Action } from './engine';
import { formatDate, shortKey, type AssistantContext, type Writer } from './messages';

/** Questions answered per group per run, so a flood of questions can't run up an AI bill. */
export const MAX_ANSWERS_PER_RUN = 5;

/** The only things the assistant is told: public group facts and the asker's own position. Never keys, invoices or wallets. */
export function buildContext(group: GroupDef, state: RoundState, member: string, autopay: boolean): AssistantContext {
  const open = state.status === 'open';
  const index = group.payoutOrder.indexOf(member);
  return {
    group: { name: group.name, amountSats: group.amountSats, frequency: group.frequency, members: group.payoutOrder.length },
    today: formatDate(Math.floor(Date.now() / 1000)),
    schedule: group.payoutOrder.map((recipient, n) => ({
      round: n + 1,
      recipient: shortKey(recipient),
      due: formatDate(roundDeadline(group, n)),
      status: n < state.round || (n === state.round && !open) ? 'complete' : n === state.round ? 'open' : 'upcoming',
    })),
    current: open
      ? {
          round: state.round + 1,
          recipient: shortKey(state.recipient),
          due: formatDate(state.deadline),
          paid: state.paid.map(shortKey),
          unpaid: unpaid(group, state).map(shortKey),
        }
      : undefined,
    asker: {
      id: shortKey(member),
      receivesInRound: index + 1,
      receivesOn: index >= 0 ? formatDate(roundDeadline(group, index)) : 'unknown',
      owesNow: open && member !== state.recipient && !state.paid.includes(member),
      invoiceReady: group.rail === 'onchain' || !!state.invoices[member],
      autopay,
    },
  };
}

/** Where reminders and answers are delivered. Only the member and the coordinator can read them. */
export interface Outbox {
  languages(group: GroupDef): Promise<Record<string, Language>>;
  questions(group: GroupDef): Promise<Question[]>;
  publishNotice(group: GroupDef, notice: Omit<Notice, 'at'>): Promise<void>;
  publishAnswer(group: GroupDef, question: Question, text: string): Promise<void>;
}

export async function sendReminders(outbox: Outbox, group: GroupDef, actions: Action[], writer: Writer): Promise<void> {
  const reminders = actions.filter((a): a is Extract<Action, { type: 'remind' }> => a.type === 'remind');
  if (!reminders.length) return;
  const languages = await outbox.languages(group);
  const autopayFailed = new Set(actions.flatMap((a) => (a.type === 'autopay-failed' ? [a.payer] : [])));

  for (const reminder of reminders) {
    for (const member of reminder.members) {
      const text = await writer.reminder({
        language: languages[member] ?? 'en',
        stage: reminder.stage,
        round: reminder.round + 1,
        amountSats: group.amountSats,
        deadline: reminder.deadline,
        autopayFailed: autopayFailed.has(member),
      });
      await outbox.publishNotice(group, { member, round: reminder.round, stage: reminder.stage, text });
    }
  }
}

export async function answerQuestions(outbox: Outbox, group: GroupDef, state: RoundState, writer: Writer, autopaying: Set<string>): Promise<number> {
  const pending = (await outbox.questions(group)).slice(0, MAX_ANSWERS_PER_RUN);
  for (const question of pending) {
    const context = buildContext(group, state, question.member, autopaying.has(question.member));
    await outbox.publishAnswer(group, question, await writer.answer(context, question.text));
  }
  return pending.length;
}
