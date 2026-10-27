import { describe, expect, it } from 'vitest';
import bolt11 from 'bolt11';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  checkVerify, standings, ON_TIME_SLACK_SECONDS, answerEvent, askEvent, noticeEvent, parseAnswer, parseAsk, parseNotice, autopayEvent, parseAutopay, createGroupKey, deferRecipient, effectiveGroup, fetchInvoice, groupEvent, secretKeyCipher, isRoundComplete, joinEvent, lightningAddressUrl,
  openRound, parseGroup, parseJoin, parseReceipt, parseRound, receiptEvent, recipientForRound,
  roundDeadline, roundEvent, unpaid, verifyReceipt, type GroupDef,
} from '../src';

const sk = () => generateSecretKey();
const [a, b, c, bot] = [sk(), sk(), sk(), sk()];
const pk = (k: Uint8Array) => getPublicKey(k);

const group: GroupDef = {
  id: 'friends-1', name: 'Friends', amountSats: 50_000, frequency: 'weekly',
  payoutOrder: [pk(a), pk(b), pk(c)], startDate: 1_800_000_000, coordinator: pk(bot),
};

// bolt11 test invoices are signed with a throwaway key, standing in for the recipient's node.
const nodeKey = bytesToHex(sk());
function makeInvoice(amountSats: number) {
  const preimage = bytesToHex(sk());
  const paymentHash = bytesToHex(sha256(Uint8Array.from(Buffer.from(preimage, 'hex'))));
  const encoded = bolt11.encode({
    satoshis: amountSats, timestamp: 1_800_000_000,
    tags: [{ tagName: 'payment_hash', data: paymentHash }, { tagName: 'description', data: 'ajo' },
      { tagName: 'payment_secret', data: bytesToHex(sk()) }],
  });
  const invoice = bolt11.sign(encoded, nodeKey).paymentRequest!;
  return { invoice, preimage, paymentHash };
}

describe('schedule', () => {
  it('assigns recipients in payout order and spaces deadlines weekly', () => {
    expect(recipientForRound(group, 1)).toBe(pk(b));
    expect(roundDeadline(group, 2)).toBe(group.startDate + 14 * 86_400);
    expect(() => recipientForRound(group, 3)).toThrow();
  });

  it('completes a round when everyone but the recipient has paid', () => {
    const state = openRound(group, 0);
    expect(unpaid(group, state)).toEqual([pk(b), pk(c)]);
    state.paid = [pk(b)];
    expect(isRoundComplete(group, state)).toBe(false);
    state.paid = [pk(b), pk(c)];
    expect(isRoundComplete(group, state)).toBe(true);
  });

  it('defers a recipient to the end of the order', () => {
    expect(deferRecipient(group, 0).payoutOrder).toEqual([pk(b), pk(c), pk(a)]);
  });
});

describe('events', () => {
  const key = createGroupKey();
  const outsider = sk();

  it('round-trips group, join and receipt through signed, encrypted events', async () => {
    const parsed = await parseGroup(finalizeEvent(await groupEvent(group, key, secretKeyCipher(a)), a), pk(b), secretKeyCipher(b));
    expect(parsed.group).toEqual(group);
    expect(parsed.ref).toEqual({ author: pk(a), id: group.id });
    expect(parsed.key).toEqual(key);

    const join = parseJoin(finalizeEvent(joinEvent({ groupId: group.id, lightningAddress: 'a@x.com' }, key), a), key);
    expect(join).toMatchObject({ member: pk(a), lightningAddress: 'a@x.com' });

    const receipt = { groupId: group.id, round: 1, payer: pk(a), recipient: pk(b), invoice: 'lnbc1', preimage: 'ff' };
    expect(parseReceipt(finalizeEvent(receiptEvent(receipt, key), a), key)).toEqual(receipt);
  });

  it('lets the coordinator read the group too', async () => {
    const event = finalizeEvent(await groupEvent(group, key, secretKeyCipher(a)), a);
    expect((await parseGroup(event, pk(bot), secretKeyCipher(bot))).group).toEqual(group);
  });

  it('keeps contents off the wire and away from outsiders', async () => {
    const groupEv = finalizeEvent(await groupEvent(group, key, secretKeyCipher(a)), a);
    const joinEv = finalizeEvent(joinEvent({ groupId: group.id, lightningAddress: 'secret@wallet.com' }, key), a);
    const receiptEv = finalizeEvent(receiptEvent({ groupId: group.id, round: 0, payer: pk(a), recipient: pk(b), invoice: 'lnbc-invoice', preimage: 'ab'.repeat(32) }, key), a);
    const stateEv = finalizeEvent(roundEvent({ ...openRound(group, 0), invoices: { [pk(b)]: 'lnbc-invoice' } }, key), bot);

    const wire = JSON.stringify([groupEv, joinEv, receiptEv, stateEv]);
    for (const secret of [group.name, 'secret@wallet.com', 'lnbc-invoice', 'ab'.repeat(32), '50000']) {
      expect(wire).not.toContain(secret);
    }
    await expect(parseGroup(groupEv, pk(outsider), secretKeyCipher(outsider))).rejects.toThrow(/no key/);
    expect(() => parseJoin(joinEv, createGroupKey())).toThrow();
  });

  it('only accepts round state from the coordinator', () => {
    const state = openRound(group, 0);
    expect(parseRound(finalizeEvent(roundEvent(state, key), bot), group, key)).toEqual(state);
    expect(() => parseRound(finalizeEvent(roundEvent(state, key), a), group, key)).toThrow(/coordinator/);
  });

  it('rejects round state that swaps in a different member list', () => {
    const state = { ...openRound(group, 0), payoutOrder: [pk(a), pk(b), pk(outsider)] };
    expect(() => parseRound(finalizeEvent(roundEvent(state, key), bot), group, key)).toThrow(/different members/);
  });

  it('follows a deferred recipient through the latest round state', () => {
    const deferred = deferRecipient(group, 0);
    const rounds = new Map([[0, openRound(deferred, 0)]]);
    expect(effectiveGroup(group, rounds).payoutOrder).toEqual([pk(b), pk(c), pk(a)]);
    expect(effectiveGroup(group, new Map())).toBe(group);
  });
});

describe('autopay grants', () => {
  const url = 'nostr+walletconnect://abc123?relay=wss://r&secret=topsecret';
  const outsider = sk();

  it('can be read by the coordinator and the member who made it, and by nobody else', async () => {
    const event = finalizeEvent(await autopayEvent(group.id, url, pk(bot), secretKeyCipher(a)), a);
    expect(JSON.stringify(event)).not.toContain('topsecret');
    expect(await parseAutopay(event, pk(a), secretKeyCipher(bot))).toEqual({ member: pk(a), nwcUrl: url });
    expect(await parseAutopay(event, pk(bot), secretKeyCipher(a))).toEqual({ member: pk(a), nwcUrl: url });
    await expect(parseAutopay(event, pk(a), secretKeyCipher(outsider))).rejects.toThrow();
  });

  it('is revoked by publishing a null connection', async () => {
    const event = finalizeEvent(await autopayEvent(group.id, null, pk(bot), secretKeyCipher(a)), a);
    expect((await parseAutopay(event, pk(a), secretKeyCipher(bot))).nwcUrl).toBeNull();
  });
});

describe('coordinator receipts', () => {
  const key = createGroupKey();
  const receipt = { groupId: group.id, round: 0, payer: pk(b), recipient: pk(a), invoice: 'lnbc1', preimage: 'ff' };

  it("names the member as payer only when the coordinator signed it", () => {
    const byBot = finalizeEvent(receiptEvent(receipt, key), bot);
    expect(parseReceipt(byBot, key, pk(bot)).payer).toBe(pk(b));
    // anyone else claiming a payer tag is still treated as the payer themselves
    const byMember = finalizeEvent(receiptEvent({ ...receipt, payer: pk(c) }, key), a);
    expect(parseReceipt(byMember, key, pk(bot)).payer).toBe(pk(a));
  });
});

describe('assistant messages', () => {
  const outsider = sk();

  it('questions can be read only by the member and the coordinator', async () => {
    const event = finalizeEvent(await askEvent(group.id, 'when is my turn?', pk(bot), secretKeyCipher(a)), a);
    expect(JSON.stringify(event)).not.toContain('turn');
    expect(await parseAsk(event, pk(a), secretKeyCipher(bot))).toMatchObject({ member: pk(a), text: 'when is my turn?', id: event.id });
    expect((await parseAsk(event, pk(bot), secretKeyCipher(a))).text).toBe('when is my turn?');
    await expect(parseAsk(event, pk(a), secretKeyCipher(outsider))).rejects.toThrow();
  });

  it('refuses empty or oversized questions', async () => {
    await expect(askEvent(group.id, '  ', pk(bot), secretKeyCipher(a))).rejects.toThrow();
    await expect(askEvent(group.id, 'x'.repeat(501), pk(bot), secretKeyCipher(a))).rejects.toThrow();
  });

  it('answers and reminders are addressed to one member and unreadable to others', async () => {
    const answer = finalizeEvent(await answerEvent(group.id, 'q1', pk(a), 'Round 2.', secretKeyCipher(bot)), bot);
    expect(await parseAnswer(answer, pk(bot), secretKeyCipher(a))).toEqual({ questionId: 'q1', member: pk(a), text: 'Round 2.', at: answer.created_at });
    const notice = finalizeEvent(await noticeEvent(group.id, { member: pk(a), round: 1, stage: 'due', text: 'Please pay.' }, secretKeyCipher(bot)), bot);
    expect(JSON.stringify(notice)).not.toContain('Please pay');
    expect(await parseNotice(notice, pk(bot), secretKeyCipher(a))).toMatchObject({ member: pk(a), round: 1, stage: 'due', text: 'Please pay.' });
    await expect(parseNotice(notice, pk(bot), secretKeyCipher(b))).rejects.toThrow();
  });

  it('keeps a member\'s language preference in their join event', () => {
    const key = createGroupKey();
    const join = parseJoin(finalizeEvent(joinEvent({ groupId: group.id, lightningAddress: 'a@x.com', language: 'yo' }, key), a), key);
    expect(join.language).toBe('yo');
  });
});

describe('standings', () => {
  const done = (round: number, extra: Partial<ReturnType<typeof openRound>> = {}) =>
    ({ ...openRound(group, round), status: 'complete' as const, ...extra });
  const d0 = group.startDate; // round 0 deadline; recipient a
  const d1 = roundDeadline(group, 1); // recipient b

  it('counts on-time, late and defaulted payments and rounds received', () => {
    const rounds = [
      done(0, { paid: [pk(b), pk(c)], paidAt: { [pk(b)]: d0 - 10, [pk(c)]: d0 + ON_TIME_SLACK_SECONDS + 1 } }),
      done(1, { paid: [pk(a)], paidAt: { [pk(a)]: d1 - 5 }, defaulted: [pk(c)] }),
    ];
    const s = standings(group, rounds);
    expect(s[pk(a)]).toMatchObject({ owed: 1, onTime: 1, late: 0, defaulted: 0, received: 1, collectedAndLeft: false });
    expect(s[pk(b)]).toMatchObject({ owed: 1, onTime: 1, late: 0, received: 1 });
    expect(s[pk(c)]).toMatchObject({ owed: 2, onTime: 0, late: 1, defaulted: 1, received: 0 });
  });

  it('flags a member who received a payout and then defaulted', () => {
    const rounds = [
      done(0, { paid: [pk(b), pk(c)], paidAt: { [pk(b)]: d0, [pk(c)]: d0 } }),
      done(1, { paid: [pk(c)], paidAt: { [pk(c)]: d1 }, defaulted: [pk(a)] }),
    ];
    expect(standings(group, rounds)[pk(a)]).toMatchObject({ received: 1, defaulted: 1, collectedAndLeft: true });
    expect(standings(group, rounds)[pk(c)].collectedAndLeft).toBe(false);
  });

  it('does not flag a member who defaulted before ever receiving', () => {
    const rounds = [done(0, { paid: [pk(b)], paidAt: { [pk(b)]: d0 }, defaulted: [pk(c)] }), done(1, { paid: [pk(a), pk(c)], paidAt: { [pk(a)]: d1, [pk(c)]: d1 } })];
    expect(standings(group, rounds)[pk(c)]).toMatchObject({ defaulted: 1, received: 0, collectedAndLeft: false });
  });

  it('ignores rounds that have not finished', () => {
    const open = { ...openRound(group, 0), paid: [pk(b)], paidAt: { [pk(b)]: d0 } };
    expect(Object.values(standings(group, [open])).every((x) => x.owed === 0 && x.received === 0)).toBe(true);
  });

  it('survives the trip through an encrypted round event', () => {
    const key = createGroupKey();
    const state = { ...openRound(group, 0), paidAt: { [pk(b)]: 123 }, defaulted: [pk(c)] };
    expect(parseRound(finalizeEvent(roundEvent(state, key), bot), group, key)).toMatchObject({ paidAt: { [pk(b)]: 123 }, defaulted: [pk(c)] });
  });
});

describe('checkVerify', () => {
  const respond = (body: unknown) => async () => ({ json: async () => body });
  it('reads a settled and an unsettled answer', async () => {
    expect(await checkVerify('https://w/verify/1', respond({ status: 'OK', settled: true, preimage: 'ab' }))).toEqual({ settled: true, preimage: 'ab' });
    expect(await checkVerify('https://w/verify/1', respond({ status: 'OK', settled: false, preimage: null }))).toEqual({ settled: false, preimage: undefined });
  });
  it('treats junk as not settled, and surfaces a provider error', async () => {
    expect((await checkVerify('https://w/v', respond('garbage'))).settled).toBe(false);
    await expect(checkVerify('https://w/v', respond({ status: 'ERROR', reason: 'unknown invoice' }))).rejects.toThrow('unknown invoice');
  });
});

describe('verifyReceipt', () => {
  it('accepts a payment against the recipient-issued invoice', () => {
    const { invoice, preimage, paymentHash } = makeInvoice(50_000);
    expect(verifyReceipt({ invoice, preimage }, { amountSats: 50_000, recipientPaymentHash: paymentHash }))
      .toEqual({ ok: true });
  });

  it('rejects an invoice the payer substituted for their own', () => {
    const real = makeInvoice(50_000);
    const fake = makeInvoice(50_000);
    const result = verifyReceipt(fake, { amountSats: 50_000, recipientPaymentHash: real.paymentHash });
    expect(result).toEqual({ ok: false, reason: 'invoice was not issued by the recipient' });
  });

  it('rejects a wrong amount and a wrong preimage', () => {
    const cheap = makeInvoice(1);
    expect(verifyReceipt(cheap, { amountSats: 50_000, recipientPaymentHash: cheap.paymentHash }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('amount') });
    const real = makeInvoice(50_000);
    expect(verifyReceipt({ invoice: real.invoice, preimage: '00'.repeat(32) },
      { amountSats: 50_000, recipientPaymentHash: real.paymentHash }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('preimage') });
  });
});

describe('lnurl', () => {
  it('builds the well-known URL and fetches an invoice', async () => {
    expect(lightningAddressUrl('amaka@wallet.example')).toBe('https://wallet.example/.well-known/lnurlp/amaka');
    expect(lightningAddressUrl('amaka@localhost:3000')).toBe('http://localhost:3000/.well-known/lnurlp/amaka');
    const seen: string[] = [];
    const fake = (async (url: string | URL) => {
      seen.push(String(url));
      return { json: async () => String(url).includes('callback')
        ? { pr: 'lnbc-invoice', verify: 'https://v' }
        : { callback: 'https://wallet.example/callback', minSendable: 1000, maxSendable: 1e9 } };
    }) as unknown as typeof fetch;
    expect(await fetchInvoice('amaka@wallet.example', 50, fake)).toEqual({ invoice: 'lnbc-invoice', verifyUrl: 'https://v' });
    expect(seen[1]).toContain('amount=50000');
  });
});
