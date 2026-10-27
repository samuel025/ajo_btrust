import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { KIND_ANSWER, KIND_ASK, KIND_AUTOPAY, KIND_GROUP, KIND_JOIN, KIND_NOTICE, KIND_RECEIPT, KIND_REQUEST, KIND_ROUND } from './kinds';
import { open, seal, unwrapKey, wrapKey, type Cipher, type GroupKey } from './crypto';
import type { GroupDef, GroupRef, Join, Language, Receipt, ReminderStage, RoundState } from './types';

const now = () => Math.floor(Date.now() / 1000);

/**
 * Group contents are encrypted with `key`. The key is wrapped for each member and the
 * coordinator, so they can read it with their own key. Only the group id and the
 * membership (`p` tags) are visible to relays.
 */
export async function groupEvent(group: GroupDef, key: GroupKey, cipher: Cipher, createdAt = now()): Promise<EventTemplate> {
  const { id, ...rest } = group;
  const readers = [...new Set([...group.payoutOrder, group.coordinator])];
  const wrapped = await Promise.all(readers.map(async (p) => ['key', p, await wrapKey(key, cipher, p)]));
  return {
    kind: KIND_GROUP,
    created_at: createdAt,
    tags: [['d', id], ...readers.map((p) => ['p', p]), ...wrapped],
    content: seal(key, rest),
  };
}

export function joinEvent(join: Join, key: GroupKey, createdAt = now()): EventTemplate {
  return {
    kind: KIND_JOIN,
    created_at: createdAt,
    tags: [['a', join.groupId]],
    content: seal(key, { lightningAddress: join.lightningAddress, language: join.language }),
  };
}

export function roundEvent(state: RoundState, key: GroupKey, createdAt = now()): EventTemplate {
  return {
    kind: KIND_ROUND,
    created_at: createdAt,
    tags: [['d', `${state.groupId}:${state.round}`], ['a', state.groupId]],
    content: seal(key, {
      recipient: state.recipient,
      deadline: state.deadline,
      paid: state.paid,
      invoices: state.invoices,
      verify: state.verify,
      payoutOrder: state.payoutOrder,
      reminders: state.reminders,
      paidAt: state.paidAt,
      defaulted: state.defaulted,
      status: state.status,
    }),
  };
}

export function receiptEvent(receipt: Receipt, key: GroupKey, createdAt = now()): EventTemplate {
  return {
    kind: KIND_RECEIPT,
    created_at: createdAt,
    tags: [
      ['a', receipt.groupId],
      ['round', String(receipt.round)],
      ['p', receipt.recipient],
      // Names the payer when the coordinator publishes the receipt for an auto-pay member.
      ['payer', receipt.payer],
    ],
    content: seal(key, { invoice: receipt.invoice, preimage: receipt.preimage }),
  };
}

function tag(event: NostrEvent, name: string): string {
  const value = event.tags.find((t) => t[0] === name)?.[1];
  if (value === undefined) throw new Error(`event is missing the "${name}" tag`);
  return value;
}

function expectKind(event: NostrEvent, kind: number) {
  if (event.kind !== kind) throw new Error(`expected kind ${kind}, got ${event.kind}`);
}

/** Reads a group event as `me`: unwraps the group key meant for them, then decrypts the definition. */
export async function parseGroup(event: NostrEvent, me: string, cipher: Cipher): Promise<{ group: GroupDef; key: GroupKey; ref: GroupRef }> {
  expectKind(event, KIND_GROUP);
  const wrapped = event.tags.find((t) => t[0] === 'key' && t[1] === me)?.[2];
  if (!wrapped) throw new Error('this group event has no key for you');
  const key = await unwrapKey(wrapped, cipher, event.pubkey);
  const id = tag(event, 'd');
  return { group: { id, ...open<Omit<GroupDef, 'id'>>(key, event.content) }, key, ref: { author: event.pubkey, id } };
}

export function parseJoin(event: NostrEvent, key: GroupKey): Join & { member: string } {
  expectKind(event, KIND_JOIN);
  const { lightningAddress, language } = open<{ lightningAddress: string; language?: Language }>(key, event.content);
  return { groupId: tag(event, 'a'), member: event.pubkey, lightningAddress, language };
}

/** Round state is only trusted when published by the group's coordinator. */
export function parseRound(event: NostrEvent, group: GroupDef, key: GroupKey): RoundState {
  expectKind(event, KIND_ROUND);
  if (event.pubkey !== group.coordinator) throw new Error('round state not signed by the coordinator');
  const groupId = tag(event, 'a');
  const round = Number(tag(event, 'd').split(':').pop());
  const state = { groupId, round, ...open<Omit<RoundState, 'groupId' | 'round'>>(key, event.content) };
  if (state.payoutOrder) {
    const same = state.payoutOrder.length === group.payoutOrder.length && group.payoutOrder.every((m) => state.payoutOrder!.includes(m));
    if (!same) throw new Error('round state reorders the group with different members');
  }
  return state;
}

/**
 * A receipt's payer is its signer, except that the group's coordinator may publish receipts
 * for members who opted in to auto-pay, naming them in the `payer` tag.
 */
export function parseReceipt(event: NostrEvent, key: GroupKey, coordinator?: string): Receipt {
  expectKind(event, KIND_RECEIPT);
  const byCoordinator = coordinator !== undefined && event.pubkey === coordinator;
  return {
    groupId: tag(event, 'a'),
    round: Number(tag(event, 'round')),
    payer: byCoordinator ? tag(event, 'payer') : event.pubkey,
    recipient: tag(event, 'p'),
    ...open<{ invoice: string; preimage: string }>(key, event.content),
  };
}

/**
 * Grants (or, with `nwcUrl: null`, revokes) the coordinator's permission to pay this member's
 * contributions. The wallet connection is encrypted to the coordinator, so relays can't read it.
 * It should carry a spending budget set in the member's own wallet.
 */
export async function autopayEvent(groupId: string, nwcUrl: string | null, coordinator: string, cipher: Cipher, createdAt = now()): Promise<EventTemplate> {
  return {
    kind: KIND_AUTOPAY,
    created_at: createdAt,
    tags: [['d', groupId], ['a', groupId], ['p', coordinator]],
    content: await cipher.encrypt(coordinator, JSON.stringify({ nwcUrl })),
  };
}

/** `peer` is the other party to the encryption: the member when the coordinator reads, the coordinator when the member does. */
export async function parseAutopay(event: NostrEvent, peer: string, cipher: Cipher): Promise<{ member: string; nwcUrl: string | null }> {
  expectKind(event, KIND_AUTOPAY);
  const { nwcUrl } = JSON.parse(await cipher.decrypt(peer, event.content)) as { nwcUrl: string | null };
  return { member: event.pubkey, nwcUrl };
}

export interface Question { id: string; member: string; text: string; at: number }
export interface Answer { questionId: string; member: string; text: string; at: number }
export interface Notice { member: string; round: number; stage: ReminderStage; text: string; at: number }

const MAX_QUESTION = 500;

/** A question for the group assistant, readable only by the member and the coordinator. */
export async function askEvent(groupId: string, text: string, coordinator: string, cipher: Cipher, createdAt = now()): Promise<EventTemplate> {
  if (!text.trim() || text.length > MAX_QUESTION) throw new Error(`a question must be 1-${MAX_QUESTION} characters`);
  return {
    kind: KIND_ASK,
    created_at: createdAt,
    tags: [['a', groupId], ['p', coordinator]],
    content: await cipher.encrypt(coordinator, JSON.stringify({ text })),
  };
}

export async function parseAsk(event: NostrEvent, peer: string, cipher: Cipher): Promise<Question> {
  expectKind(event, KIND_ASK);
  const { text } = JSON.parse(await cipher.decrypt(peer, event.content)) as { text: string };
  if (typeof text !== 'string' || text.length > MAX_QUESTION) throw new Error('malformed question');
  return { id: event.id, member: event.pubkey, text, at: event.created_at };
}

export async function answerEvent(groupId: string, questionId: string, member: string, text: string, cipher: Cipher, createdAt = now()): Promise<EventTemplate> {
  return {
    kind: KIND_ANSWER,
    created_at: createdAt,
    tags: [['a', groupId], ['p', member], ['e', questionId]],
    content: await cipher.encrypt(member, JSON.stringify({ text })),
  };
}

export async function parseAnswer(event: NostrEvent, peer: string, cipher: Cipher): Promise<Answer> {
  expectKind(event, KIND_ANSWER);
  const { text } = JSON.parse(await cipher.decrypt(peer, event.content)) as { text: string };
  return { questionId: tag(event, 'e'), member: tag(event, 'p'), text, at: event.created_at };
}

export async function noticeEvent(groupId: string, notice: Omit<Notice, 'at'>, cipher: Cipher, createdAt = now()): Promise<EventTemplate> {
  return {
    kind: KIND_NOTICE,
    created_at: createdAt,
    tags: [['a', groupId], ['p', notice.member], ['round', String(notice.round)], ['stage', notice.stage]],
    content: await cipher.encrypt(notice.member, JSON.stringify({ text: notice.text })),
  };
}

export async function parseNotice(event: NostrEvent, peer: string, cipher: Cipher): Promise<Notice> {
  expectKind(event, KIND_NOTICE);
  const { text } = JSON.parse(await cipher.decrypt(peer, event.content)) as { text: string };
  return { member: tag(event, 'p'), round: Number(tag(event, 'round')), stage: tag(event, 'stage') as ReminderStage, text, at: event.created_at };
}

export interface JoinRequest { id: string; member: string; lightningAddress: string; language?: Language; at: number }

/** Someone with an invite link asks the organizer to add them. Only the organizer can read it. */
export async function requestEvent(groupId: string, organizer: string, request: { lightningAddress: string; language?: Language }, cipher: Cipher, createdAt = now()): Promise<EventTemplate> {
  return {
    kind: KIND_REQUEST,
    created_at: createdAt,
    tags: [['a', groupId], ['p', organizer]],
    content: await cipher.encrypt(organizer, JSON.stringify(request)),
  };
}

/** `peer` is the organizer when the requester reads their own request, and the requester when the organizer reads it. */
export async function parseRequest(event: NostrEvent, peer: string, cipher: Cipher): Promise<JoinRequest> {
  expectKind(event, KIND_REQUEST);
  const { lightningAddress, language } = JSON.parse(await cipher.decrypt(peer, event.content)) as { lightningAddress: string; language?: Language };
  if (typeof lightningAddress !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(lightningAddress)) throw new Error('malformed request');
  return { id: event.id, member: event.pubkey, lightningAddress, language, at: event.created_at };
}
