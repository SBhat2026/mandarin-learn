import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { speak, playAudio, captureSpoken, spokenCaptureSupported } from '../lib/speech.js';
import { TonedHanzi, TonedPinyin } from '../components/Toned.jsx';

// Laoshi — a conversational Mandarin teacher (Qwen). Stays within what the learner
// knows, corrects gently, keeps them talking. Not a general assistant.
export default function Laoshi() {
  const [msgs, setMsgs] = useState([]);        // {role, hanzi, pinyin, english, note}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const scroller = useRef(null);
  const canSpeak = spokenCaptureSupported();

  useEffect(() => { api.laoshiStatus().then(setStatus).catch(() => setStatus({ available: false })); }, []);
  useEffect(() => {
    // Laoshi opens the conversation.
    if (status?.available && msgs.length === 0) send('', true);
  }, [status]);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [msgs, busy]);

  async function send(text, opening = false) {
    if (busy) return;
    const history = msgs.map(m => ({ role: m.role, content: m.role === 'user' ? m.hanzi : (m.hanzi + ' ' + (m.english || '')) }));
    if (!opening) setMsgs(m => [...m, { role: 'user', hanzi: text }]);
    setInput(''); setBusy(true);
    try {
      const reply = await api.laoshi({ userText: text, history });
      setMsgs(m => [...m, { role: 'assistant', ...reply }]);
      if (reply.hanzi) speak(reply.hanzi);
    } catch {
      setMsgs(m => [...m, { role: 'assistant', hanzi: '', english: 'Laoshi is unavailable. Start Ollama or set DASHSCOPE_API_KEY.' }]);
    } finally { setBusy(false); }
  }

  async function mic() {
    if (!canSpeak || listening || busy) return;
    setListening(true); setLevel(0);
    try {
      const cap = await captureSpoken({ expectedSyllables: 2, timeoutMs: 6000, onLevel: setLevel });
      if (cap.transcript) setInput(cap.transcript);   // confirm/edit, then send
    } catch {} finally { setListening(false); }
  }

  if (status && !status.available) {
    return (
      <div className="text-center py-16">
        <div className="hanzi text-5xl text-ink-faint mb-4">老师</div>
        <p className="text-ink-soft text-sm max-w-sm mx-auto">Laoshi runs on a local Qwen model. Start it with
          <code className="mx-1 text-ink">ollama run qwen3.5</code> or set <code className="text-ink">DASHSCOPE_API_KEY</code>.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-9rem)]">
      <div className="flex items-center gap-2 mb-3">
        <span className="hanzi text-2xl text-ink">老师</span>
        <span className="text-sm text-ink-soft">Laoshi · practice conversation</span>
      </div>

      <div ref={scroller} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {msgs.map((m, i) => m.role === 'user'
          ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-ink text-white">
                <span className="hanzi text-lg">{m.hanzi}</span>
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-bl-md bg-white border border-line">
                {m.hanzi && <div onClick={() => speak(m.hanzi)} className="cursor-pointer">
                  <TonedHanzi hanzi={m.hanzi} pinyin={m.pinyin} size="text-2xl" />
                </div>}
                {m.pinyin && <div className="mt-1"><TonedPinyin pinyin={m.pinyin} className="text-sm" /></div>}
                {m.english && <div className="text-sm text-ink-soft mt-1">{m.english}</div>}
                {m.note && <div className="text-[12px] text-jade-600 mt-2 border-t border-line pt-2">💡 {m.note}</div>}
                {m.hanzi && <button onClick={() => playAudio({ hanzi: m.hanzi })} className="mt-2 text-xs text-ink-faint hover:text-ink">🔊 replay</button>}
              </div>
            </div>
          ))}
        {busy && <div className="text-ink-faint text-sm px-2">老师 is thinking…</div>}
      </div>

      <div className="mt-3">
        {listening && <div className="text-center text-sm text-rose-500 mb-2 animate-pulse">Listening… speak now</div>}
        <form onSubmit={(e) => { e.preventDefault(); if (input.trim()) send(input.trim()); }}
          className="flex items-center gap-2">
          {canSpeak && (
            <button type="button" onClick={mic} disabled={busy}
              style={listening ? { transform: `scale(${1 + Math.min(0.5, level * 5)})` } : undefined}
              className={`w-12 h-12 shrink-0 rounded-full grid place-items-center transition ${
                listening ? 'bg-rose-500 text-white shadow-lg shadow-rose-200' : 'bg-white border border-line hover:border-ink/30'}`}>🎤</button>
          )}
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={canSpeak ? 'Tap 🎤 to speak, or type…' : 'Type in Chinese or English…'}
            className="flex-1 px-4 py-3 rounded-full border border-line bg-white focus:outline-none focus:border-ink/40 hanzi" />
          <button type="submit" disabled={busy || !input.trim()}
            className="w-12 h-12 shrink-0 rounded-full bg-ink text-white grid place-items-center disabled:opacity-40">↑</button>
        </form>
      </div>
    </div>
  );
}
