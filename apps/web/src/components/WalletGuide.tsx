import { useState } from 'react';
import { LANGUAGES, type Language } from '@ajo/core';
import { askGuide, useAiEnabled, type GuideTurn } from '../lib/ai';

const SUGGESTIONS = ['What is a Lightning wallet?', 'What is a Lightning address?', 'How do I get paid when it is my turn?', 'What is a connection?'];

/** A small chat that explains wallets in the person's language, using only what the app knows. Hidden when the AI is off. */
export function WalletGuide() {
  const enabled = useAiEnabled();
  const [language, setLanguage] = useState<Language>('en');
  const [turns, setTurns] = useState<GuideTurn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!enabled) return null;

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setError(undefined);
    setBusy(true);
    setText('');
    const before = turns;
    setTurns([...before, { role: 'user', text: q }]);
    try {
      const reply = await askGuide(q, language, before);
      setTurns((t) => [...t, { role: 'guide', text: reply }]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="guide">
      <h3>Ask the guide</h3>
      <p className="muted small">It explains wallets and how this app uses them. It can't see your money and doesn't know which wallets are available where you live.</p>
      <label className="small">Language
        <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {Object.entries(LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </label>
      {turns.length === 0 && (
        <p className="chips">{SUGGESTIONS.map((s) => <button key={s} type="button" className="chip" onClick={() => ask(s)}>{s}</button>)}</p>
      )}
      {turns.map((t, i) => <p key={i} className={t.role === 'user' ? 'q' : 'a'}>{t.text}</p>)}
      {busy && <p className="muted">Thinking…</p>}
      {error && <p className="error">{error}</p>}
      <form className="askrow" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="Ask a question" />
        <button aria-busy={busy} disabled={busy || !text.trim()}>Ask</button>
      </form>
      <p className="muted small">Never type your recovery words or passwords here. Questions are sent to Google's Gemini model by this app's coordinator.</p>
    </div>
  );
}
