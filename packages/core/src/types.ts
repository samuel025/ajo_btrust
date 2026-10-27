export type Frequency = 'weekly' | 'biweekly' | 'monthly';

export interface GroupDef {
  /** Stable id, used as the `d` tag of the group event. */
  id: string;
  name: string;
  amountSats: number;
  frequency: Frequency;
  /** Hex pubkeys, in payout order. Every member receives exactly once. */
  payoutOrder: string[];
  /** Unix seconds when round 0 is due. */
  startDate: number;
  /** Hex pubkey of the coordinator bot, allowed to publish round state. */
  coordinator: string;
  /** True while the organizer is still adding members from invite links. The coordinator ignores a forming group. */
  forming?: boolean;
}

/** A group is addressed by its organizer and id, so nobody else can publish a lookalike. */
export interface GroupRef {
  author: string;
  id: string;
}

export type Language = 'en' | 'pcm' | 'yo' | 'ha';

export const LANGUAGES: Record<Language, string> = {
  en: 'English',
  pcm: 'Pidgin',
  yo: 'Yoruba',
  ha: 'Hausa',
};

export type ReminderStage = 'due' | 'overdue';

export interface Join {
  groupId: string;
  /** Where other members pay this member when it is their turn. */
  lightningAddress: string;
  /** Language for reminders. */
  language?: Language;
}

export interface RoundState {
  groupId: string;
  round: number;
  recipient: string;
  /** Unix seconds. */
  deadline: number;
  paid: string[];
  /**
   * BOLT11 invoices the coordinator fetched from the recipient's Lightning address,
   * one per payer. A receipt only counts if it settles the payer's invoice here.
   */
  invoices: Record<string, string>;
  /** The payout order in force this round; differs from the group's once a recipient is deferred. */
  payoutOrder?: string[];
  /** The latest reminder each member has been sent this round, so none is sent twice. */
  reminders?: Record<string, ReminderStage>;
  /** LNURL "verify" URLs the coordinator can poll to see whether each member's invoice was paid, by member. */
  verify?: Record<string, string>;
  /** When the coordinator first saw each member's payment (unix seconds). Signed by the coordinator, so members can't backdate it. */
  paidAt?: Record<string, number>;
  /** Members who didn't pay by the default deadline; the round closed without their contribution. */
  defaulted?: string[];
  status: 'open' | 'complete' | 'skipped';
}

export interface Receipt {
  groupId: string;
  round: number;
  payer: string;
  recipient: string;
  invoice: string;
  preimage: string;
}
