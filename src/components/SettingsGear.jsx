import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// Playtesting settings: switch which Claude model authors the invisible passes
// (Director blueprint, harvest, understanding). Per-user, persisted, no restart.
// Kept deliberately small and unobtrusive — a gear in the header, not a settings page.
export default function SettingsGear() {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => { api.modelSettings().then(setS).catch(() => setS({ pref: 'fast', richAvailable: false })); }, []);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  async function choose(pref) {
    if (busy || !s || pref === s.pref) return;
    setBusy(true);
    try { const next = await api.setModelPref(pref); setS(v => ({ ...v, ...next })); }
    finally { setBusy(false); }
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)} aria-label="Settings"
        className="w-8 h-8 rounded-full flex items-center justify-center text-ink-soft hover:text-ink hover:bg-white/70 transition-colors">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 bg-white border border-line rounded-2xl shadow-lg p-4 z-30 animate-fade">
          <div className="text-[13px] font-medium text-ink mb-1">Teacher-planner model</div>
          <div className="text-[11.5px] text-ink-faint mb-3 leading-snug">
            Which Claude model quietly plans the conversation. The learner never sees it — for your playtesting only.
          </div>
          <div className="flex gap-1.5 bg-[#faf9f7] rounded-full p-1 border border-line">
            {[['fast', 'Haiku · cheap'], ['rich', 'Sonnet · richer']].map(([val, label]) => (
              <button key={val} onClick={() => choose(val)} disabled={busy}
                className={`flex-1 px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors ${
                  s?.pref === val ? 'bg-ink text-white shadow-sm' : 'text-ink-soft hover:text-ink'}`}>
                {label}
              </button>
            ))}
          </div>
          {s && !s.hasApiKey && (
            <div className="text-[11px] text-ink-faint mt-2.5">No Claude key set — the offline planner runs regardless.</div>
          )}
          {s && s.hasApiKey && s.pref === 'rich' && !s.richAvailable && (
            <div className="text-[11px] text-amber-600 mt-2.5">Sonnet id not configured yet (CLAUDE_MODEL_RICH is blank) — using Haiku until you set it.</div>
          )}
        </div>
      )}
    </div>
  );
}
