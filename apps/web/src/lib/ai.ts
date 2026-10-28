import { useEffect, useState } from 'react';
import type { Frequency, Language } from '@ajo/core';
import { nairaToSats } from './rate';

/** Where the coordinator's AI service is: set at build time, the same site in a hosted setup, the local bot in development. */
export const AI_URL: string = import.meta.env.VITE_AI_URL ?? (import.meta.env.DEV ? 'http://localhost:3480' : '/ai');

let status: Promise<boolean> | undefined;
/** Whether the AI features are switched on, asked once per page load. A server that can't be reached counts as off, so nothing broken is shown. */
export function aiEnabled(): Promise<boolean> {
  status ??= fetch(`${AI_URL}/status`, { signal: AbortSignal.timeout(4000) })
    .then(async (r) => r.ok && ((await r.json()) as { enabled?: boolean }).enabled === true)
    .catch(() => false);
  return status;
}

export function useAiEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => { let alive = true; void aiEnabled().then((v) => { if (alive) setOn(v); }); return () => { alive = false; }; }, []);
  return on;
}

/** Calls the AI service and turns every kind of failure into a sentence a person can act on. */
async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${AI_URL}${path}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    // Waiting too long is a different problem from not being able to connect, and the advice differs.
    if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') throw new Error('The assistant is taking too long to answer. Please try again in a moment.');
    throw new Error("Couldn't reach the assistant. Check that the coordinator is running, then try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 429) throw new Error('You have asked a lot in a short time. Please try again in a little while.');
  if (!res.ok) throw new Error(data.error ?? 'The assistant is not available right now.');
  return data as T;
}

export interface GroupDraft { name?: string; amountNaira?: number; amountSats?: number; frequency?: Frequency; startDate?: string; members?: number }

export const describeGroup = async (description: string) => (await post<{ draft: GroupDraft }>('/group-draft', { description })).draft;

export interface GuideTurn { role: 'user' | 'guide'; text: string }
export const askGuide = async (question: string, language: Language, history: GuideTurn[]) => (await post<{ reply: string }>('/guide', { question, language, history })).reply;

/* ---------- putting a draft into the New group form ---------- */

export interface FormValues { name: string; amount: string; frequency: Frequency; start: string }

export interface Applied { values: Partial<FormValues>; /** What was filled in, in words, for the person to check. */ changed: string[]; notes: string[] }

/** Turns the AI's draft into form values. The person reviews them before anything is created. */
export function applyDraft(draft: GroupDraft, ngnPerBtc: number | undefined): Applied {
  const values: Partial<FormValues> = {};
  const changed: string[] = [];
  const notes: string[] = [];
  if (draft.name) { values.name = draft.name; changed.push(`name: ${draft.name}`); }
  if (draft.amountSats) { values.amount = String(draft.amountSats); changed.push(`${draft.amountSats.toLocaleString('en')} sats per round`); }
  else if (draft.amountNaira) {
    if (ngnPerBtc) {
      const sats = nairaToSats(draft.amountNaira, ngnPerBtc);
      values.amount = String(sats);
      changed.push(`₦${draft.amountNaira.toLocaleString('en')} per round (${sats.toLocaleString('en')} sats at today's rate)`);
    } else notes.push(`You said ₦${draft.amountNaira.toLocaleString('en')} per round, but the exchange rate isn't available right now, so the amount is unchanged. Enter it in the naira box once the rate shows.`);
  }
  if (draft.frequency) { values.frequency = draft.frequency; changed.push(`${draft.frequency === 'biweekly' ? 'every two weeks' : draft.frequency}`); }
  if (draft.startDate) { values.start = draft.startDate; changed.push(`first round due ${draft.startDate}`); }
  if (draft.members) notes.push(`You mentioned ${draft.members} people. You invite them by link after the group is created.`);
  return { values, changed, notes };
}
