import { nip19 } from 'nostr-tools';
import { LANGUAGES, type Language, type ReminderStage } from '@ajo/core';

export const shortKey = (hex: string) => {
  const npub = nip19.npubEncode(hex);
  return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
};

/** A date and time in Lagos time, e.g. "Oct 30, 9:00 AM GMT+1": a due date is a moment, not just a day. */
export const formatDate = (unix: number) =>
  new Date(unix * 1000).toLocaleString('en', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos', timeZoneName: 'short' });

export interface ReminderFacts {
  language: Language;
  stage: ReminderStage;
  /** 1-based, as members see it. */
  round: number;
  amountSats: number;
  deadline: number;
  /** The member's auto-pay was tried and failed, so they need to pay by hand. */
  autopayFailed?: boolean;
}

export interface AssistantContext {
  group: { name: string; amountSats: number; frequency: string; members: number };
  today: string;
  schedule: { round: number; recipient: string; due: string; status: 'complete' | 'open' | 'upcoming' }[];
  current?: { round: number; recipient: string; due: string; paid: string[]; unpaid: string[] };
  asker: { id: string; receivesInRound: number; receivesOn: string; owesNow: boolean; invoiceReady: boolean; autopay: boolean };
}

/** Produces the words members read. Implementations must never throw for a valid input. */
export interface Writer {
  reminder(facts: ReminderFacts): Promise<string>;
  answer(context: AssistantContext, question: string): Promise<string>;
}

// NOTE: the Pidgin, Yoruba and Hausa wording below has not been reviewed by native speakers.
type Template = (v: { amount: string; n: number; date: string }) => string;
const TEMPLATES: Record<Language, Record<ReminderStage, Template>> = {
  en: {
    due: ({ amount, n, date }) => `Reminder: your ${amount} contribution for round ${n} is due on ${date}. Open the app and tap Pay.`,
    overdue: ({ amount, n, date }) => `Your ${amount} contribution for round ${n} was due on ${date} and hasn't been received. Please pay as soon as you can so the round can close.`,
  },
  pcm: {
    due: ({ amount, n, date }) => `Abeg no forget: your ${amount} ajo contribution for round ${n} go due on ${date}. Open the app, tap Pay.`,
    overdue: ({ amount, n, date }) => `Your ${amount} ajo contribution for round ${n} don pass ${date} and we never see am. Abeg pay now make the round fit close.`,
  },
  yo: {
    due: ({ amount, n, date }) => `Ìránnilétí: owó ajo rẹ, ${amount}, fún àyípo ${n} yóò tó ní ${date}. Jọ̀wọ́ ṣí app náà kí o tẹ Pay.`,
    overdue: ({ amount, n, date }) => `Owó ajo rẹ, ${amount}, fún àyípo ${n} ti tó ní ${date} ṣùgbọ́n a kò tíì gbà á. Jọ̀wọ́ sanwó kíákíá kí a lè parí àyípo náà.`,
  },
  ha: {
    due: ({ amount, n, date }) => `Tunatarwa: gudummawar ajo ɗinka ta ${amount} don zagaye na ${n} za ta cika a ${date}. Don Allah buɗe manhajar ka danna Pay.`,
    overdue: ({ amount, n, date }) => `Gudummawar ajo ɗinka ta ${amount} don zagaye na ${n} ta cika a ${date} amma ba mu karɓa ba. Don Allah ka biya da wuri don a rufe zagayen.`,
  },
};

const AUTOPAY_FAILED: Record<Language, string> = {
  en: " Your auto-pay didn't go through, so please pay by hand.",
  pcm: ' Your auto-pay no work, so abeg pay am by hand.',
  yo: ' Ìsanwó àdánidá rẹ kò ṣiṣẹ́, nítorí náà jọ̀wọ́ san án fúnra rẹ.',
  ha: ' Biyan kai-tsaye bai yi nasara ba, don haka ka biya da hannu.',
};

export const formatSats = (sats: number) => `${sats.toLocaleString('en')} sats`;

export function templateReminder(f: ReminderFacts): string {
  const text = TEMPLATES[f.language][f.stage]({ amount: formatSats(f.amountSats), n: f.round, date: formatDate(f.deadline) });
  return f.autopayFailed ? text + AUTOPAY_FAILED[f.language] : text;
}

/** A plain, factual answer for when the AI isn't available: always English. */
export function templateAnswer(c: AssistantContext): string {
  const lines: string[] = [];
  if (c.current) {
    const cur = c.current;
    lines.push(
      c.asker.owesNow
        ? `Round ${cur.round}: you pay ${cur.recipient} ${formatSats(c.group.amountSats)} by ${cur.due}.`
        : `Round ${cur.round} is paid to ${cur.recipient}, due ${cur.due}.`,
    );
    lines.push(`${cur.paid.length} of ${cur.paid.length + cur.unpaid.length} have paid.`);
  }
  lines.push(`You receive in round ${c.asker.receivesInRound}, around ${c.asker.receivesOn}.`);
  return lines.join(' ');
}

export const templateWriter: Writer = {
  reminder: async (facts) => templateReminder(facts),
  answer: async (context) => templateAnswer(context),
};

export const languageName = (language: Language) => LANGUAGES[language];
