import { SimplePool, finalizeEvent, getPublicKey, type Filter } from 'nostr-tools';
import {
  KIND_AUTOPAY, KIND_GROUP, KIND_JOIN, KIND_RECEIPT, KIND_ROUND, parseAutopay, parseGroup, parseJoin, parseReceipt, parseRound,
  receiptEvent, roundEvent, secretKeyCipher, type GroupKey, type GroupRef, type Receipt, type RoundState,
} from '@ajo/core';
import type { Ledger } from './runner';

/** Ledger backed by Nostr relays. Events are signed and decrypted with the coordinator's key. */
export function nostrLedger(relays: string[], secretKey: Uint8Array): Ledger {
  const pool = new SimplePool();
  const botPubkey = getPublicKey(secretKey);
  const cipher = secretKeyCipher(secretKey);
  const keys = new Map<string, GroupKey>();
  const query = (filter: Filter) => pool.querySync(relays, filter);
  const keyFor = (groupId: string) => {
    const key = keys.get(groupId);
    if (!key) throw new Error(`group ${groupId} has not been read yet`);
    return key;
  };

  return {
    async group(ref) {
      const events = await query({ kinds: [KIND_GROUP], authors: [ref.author], '#d': [ref.id] });
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!latest) return undefined;
      const { group, key } = await parseGroup(latest, botPubkey, cipher);
      keys.set(group.id, key);
      return group;
    },
    async addresses(group) {
      const key = keyFor(group.id);
      const events = await query({ kinds: [KIND_JOIN], '#a': [group.id] });
      const addresses: Record<string, string> = {};
      for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
        if (!group.payoutOrder.includes(event.pubkey)) continue;
        try { addresses[event.pubkey] = parseJoin(event, key).lightningAddress; } catch { /* undecryptable joins are ignored */ }
      }
      return addresses;
    },
    async receipts(group) {
      const key = keyFor(group.id);
      const events = await query({ kinds: [KIND_RECEIPT], '#a': [group.id] });
      const receipts: Receipt[] = [];
      for (const event of events) {
        try { receipts.push(parseReceipt(event, key, group.coordinator)); } catch { /* malformed receipts are ignored */ }
      }
      return receipts;
    },
    async grants(group) {
      const events = await query({ kinds: [KIND_AUTOPAY], '#a': [group.id], authors: group.payoutOrder });
      const grants: Record<string, string> = {};
      const seen = new Set<string>();
      for (const event of events.sort((a, b) => b.created_at - a.created_at)) {
        if (seen.has(event.pubkey)) continue; // only a member's newest grant counts; it may be a revocation
        seen.add(event.pubkey);
        try {
          const { nwcUrl } = await parseAutopay(event, event.pubkey, cipher);
          if (nwcUrl) grants[event.pubkey] = nwcUrl;
        } catch { /* unreadable grants are ignored */ }
      }
      return grants;
    },
    async publishReceipt(receipt: Receipt) {
      await Promise.all(pool.publish(relays, finalizeEvent(receiptEvent(receipt, keyFor(receipt.groupId)), secretKey)));
    },
    async round(group, round) {
      const events = await query({ kinds: [KIND_ROUND], authors: [group.coordinator], '#d': [`${group.id}:${round}`] });
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      return latest && parseRound(latest, group, keyFor(group.id));
    },
    // Replaceable events with equal timestamps can resolve to the older one, so a republish
    // must be strictly newer than what the relays already hold.
    async publishRound(state: RoundState) {
      const existing = await query({ kinds: [KIND_ROUND], authors: [botPubkey], '#d': [`${state.groupId}:${state.round}`] });
      const newest = Math.max(0, ...existing.map((e) => e.created_at));
      const template = roundEvent(state, keyFor(state.groupId), Math.max(Math.floor(Date.now() / 1000), newest + 1));
      await Promise.all(pool.publish(relays, finalizeEvent(template, secretKey)));
    },
  };
}

/** Groups that name this coordinator and were published by one of the given organizers. */
export async function discoverGroups(relays: string[], secretKey: Uint8Array, organizers: string[]): Promise<GroupRef[]> {
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays, { kinds: [KIND_GROUP], authors: organizers, '#p': [getPublicKey(secretKey)] });
    const refs = new Map<string, GroupRef>();
    for (const event of events) {
      const id = event.tags.find((t) => t[0] === 'd')?.[1];
      if (id) refs.set(`${event.pubkey}:${id}`, { author: event.pubkey, id });
    }
    return [...refs.values()];
  } finally {
    pool.close(relays);
  }
}
