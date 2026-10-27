import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { KIND_AUTOPAY, KIND_GROUP, KIND_JOIN, KIND_RECEIPT, KIND_ROUND } from './kinds';
import { open, seal, unwrapKey, wrapKey, type Cipher, type GroupKey } from './crypto';
import type { GroupDef, GroupRef, Join, Receipt, RoundState } from './types';

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
    content: seal(key, { lightningAddress: join.lightningAddress }),
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
      payoutOrder: state.payoutOrder,
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
  return {
    groupId: tag(event, 'a'),
    member: event.pubkey,
    lightningAddress: open<{ lightningAddress: string }>(key, event.content).lightningAddress,
  };
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
