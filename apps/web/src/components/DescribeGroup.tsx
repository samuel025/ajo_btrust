import { useState } from 'react';
import { applyDraft, describeGroup, useAiEnabled, type Applied, type FormValues } from '../lib/ai';
import type { Rate } from '../lib/rate';

/** "Describe your group in a sentence" at the top of New group: the AI fills in the form, and the person checks it. */
export function DescribeGroup({ rate, onFill }: { rate?: Rate; onFill: (values: Partial<FormValues>) => void }) {
  const enabled = useAiEnabled();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Applied>();
  if (!enabled) return null;

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setResult(undefined);
    setBusy(true);
    try {
      const applied = applyDraft(await describeGroup(text), rate?.ngnPerBtc);
      if (!Object.keys(applied.values).length && !applied.notes.length) setError("I couldn't pick out any settings from that. Try something like: \"8 of us, ₦20,000 each, monthly, starting 1 December\".");
      else { onFill(applied.values); setResult(applied); }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card describe" onSubmit={run}>
      <h2>Describe your group</h2>
      <p className="muted small">Say it in your own words and the form below is filled in for you. You check everything before creating the group. The AI never creates anything by itself.</p>
      <textarea rows={2} maxLength={600} value={text} onChange={(e) => setText(e.target.value)} placeholder="8 of us at work, ₦20,000 each, monthly, starting 1 December" />
      <button aria-busy={busy} disabled={busy || text.trim().length < 5}>{busy ? 'Reading…' : 'Fill in the form'}</button>
      {error && <p className="error">{error}</p>}
      {result && (
        <div className="notice small">
          {result.changed.length > 0 && <p><b>Filled in:</b> {result.changed.join(' · ')}. Please check these below.</p>}
          {result.notes.map((n) => <p key={n}>{n}</p>)}
        </div>
      )}
      <p className="muted small">The text you type is sent to Google's Gemini model by this app's coordinator. Don't include anything private.</p>
    </form>
  );
}
