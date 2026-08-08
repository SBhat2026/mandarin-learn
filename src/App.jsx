import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api, isDemo, currentUser, accessToken, setAccessToken, verifyAccess, setLockHandler } from './lib/api.js';
import Home from './pages/Home.jsx';
import Session from './pages/Session.jsx';
import ToneTrainer from './pages/ToneTrainer.jsx';
import Reading from './pages/Reading.jsx';
import Stats from './pages/Stats.jsx';
import Onboarding from './pages/Onboarding.jsx';
import SettingsGear from './components/SettingsGear.jsx';
import Login from './components/Login.jsx';
import UserChip from './components/UserChip.jsx';

// One primary action — talking with Laoshi — with the practice tools kept secondary.
const tabs = [
  ['/', 'Home'],
  ['/converse', 'Talk'],
  ['/reading', 'Reading'],
  ['/tones', 'Tones'],
  ['/stats', 'Progress'],
];

export default function App() {
  const [meta, setMeta] = useState(null);
  // Multi-user gate: require a chosen local user before loading the app (skipped in
  // the static demo, which has no backend / user routing).
  const [user, setUser] = useState(isDemo ? 'demo' : currentUser());
  // Hosted instances add a shared passphrase in front of everything. `null` while
  // we're still asking the server whether one is needed.
  const [locked, setLocked] = useState(null);
  const navigate = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    if (isDemo) { setLocked(false); return; }
    setLockHandler(() => setLocked(true));
    verifyAccess(accessToken()).then(r => setLocked(r.required && !r.ok)).catch(() => setLocked(false));
  }, []);

  useEffect(() => {
    if (!user || locked !== false) return;   // wait for a user AND an unlocked instance
    api.meta().then(m => {
      setMeta(m);
      if (!m.onboarding?.onboarded && m.counts.units > 0) navigate('/onboarding');
    }).catch(() => setMeta({ error: true }));
  }, [user, locked]);

  if (locked === null) return null;                       // brief: gate status unknown
  if (locked) return <AccessGate onUnlock={() => setLocked(false)} />;

  // Switching user reloads everyone's data cleanly.
  function onSwitch() { window.location.reload(); }

  if (!user) return <Login onPick={setUser} />;

  const onOnboarding = loc.pathname === '/onboarding';

  return (
    <div className="min-h-screen flex flex-col">
      {!onOnboarding && (
        <header className="sticky top-0 z-20 bg-[#faf9f7]/85 backdrop-blur-xl border-b border-line">
          <div className="max-w-3xl mx-auto px-5 h-16 flex items-center">
            <NavLink to="/" className="flex items-center gap-2.5 mr-6">
              <span className="hanzi text-[26px] leading-none text-ink">学</span>
              <span className="text-[13px] font-medium text-ink-faint tracking-wide hidden sm:block">Mandarin</span>
            </NavLink>
            <nav className="flex items-center gap-0.5 bg-white/60 rounded-full p-1 border border-line">
              {tabs.map(([to, label]) => (
                <NavLink key={to} to={to} end={to === '/'}
                  className={({ isActive }) =>
                    `px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-colors ${
                      isActive ? 'bg-ink text-white shadow-sm' : 'text-ink-soft hover:text-ink'}`}>
                  {label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-1.5">
              <SettingsGear />
              {!isDemo && <UserChip onSwitch={onSwitch} />}
            </div>
          </div>
        </header>
      )}

      <main className={`flex-1 w-full mx-auto px-5 ${onOnboarding ? 'max-w-2xl py-10' : 'max-w-3xl py-10'}`}>
        {isDemo && (
          <div className="mb-6 flex items-center gap-2 text-[12.5px] text-ink-soft bg-white border border-line rounded-full px-4 py-2 w-fit mx-auto">
            <span className="w-1.5 h-1.5 rounded-full bg-jade-400" />
            Live demo — read-only preview with a baked snapshot. Reviews don’t persist; audio uses your browser’s voice. Full app runs locally with the backend.
          </div>
        )}
        {meta?.counts?.units === 0 && (
          <div className="mb-6 p-4 rounded-2xl bg-white border border-line text-ink-soft text-sm">
            No content yet. Run <code className="text-ink">npm run ingest:all</code> to import decks and build units.
          </div>
        )}
        <div className="animate-fade">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/converse" element={<Session />} />
            {/* legacy routes → the unified conversation surface */}
            <Route path="/session" element={<Navigate to="/converse" replace />} />
            <Route path="/laoshi" element={<Navigate to="/converse" replace />} />
            <Route path="/tones" element={<ToneTrainer />} />
            <Route path="/reading" element={<Reading />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/onboarding" element={<Onboarding onDone={() => api.meta().then(setMeta)} />} />
          </Routes>
        </div>
        <SpendFooter />
      </main>
    </div>
  );
}

// The shared-passphrase gate for hosted instances. Deliberately plain: this is a
// doorway, not a product surface, and it never claims to be an account system.
function AccessGate({ onUnlock }) {
  const [pass, setPass] = useState('');
  const [state, setState] = useState('idle');   // idle | checking | wrong

  async function submit(e) {
    e.preventDefault();
    if (!pass.trim() || state === 'checking') return;
    setState('checking');
    try {
      const r = await verifyAccess(pass.trim());
      if (r.ok) { setAccessToken(pass.trim()); onUnlock(); }
      else { setState('wrong'); setPass(''); }
    } catch { setState('wrong'); }
  }

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <form onSubmit={submit} className="w-full max-w-sm text-center">
        <div className="hanzi text-5xl text-ink mb-3">学</div>
        <h1 className="text-xl font-semibold text-ink mb-1.5">Mandarin Learn</h1>
        <p className="text-sm text-ink-soft mb-6">Private test build — enter the passphrase you were given.</p>
        <input
          type="password" value={pass} autoFocus
          onChange={(e) => { setPass(e.target.value); if (state === 'wrong') setState('idle'); }}
          placeholder="Passphrase"
          className={`w-full px-4 py-3 rounded-full border bg-white text-center focus:outline-none transition
            ${state === 'wrong' ? 'border-rose-300 focus:border-rose-400' : 'border-line focus:border-ink/40'}`} />
        {state === 'wrong' && <div className="text-[13px] text-rose-600 mt-2">Not quite — try again.</div>}
        <button type="submit" disabled={!pass.trim() || state === 'checking'}
          className="mt-4 w-full py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition disabled:opacity-40">
          {state === 'checking' ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

// A deliberately quiet readout of metered API spend. Not a dashboard: one line,
// faint, at the very bottom — enough to notice a jump without it becoming part of
// the study surface. Hidden entirely when nothing is metered (all-local setup).
function SpendFooter() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.spend?.().then(d => alive && setS(d)).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!s || (!s.total && !s.remaining)) return null;
  return (
    <div className="mt-10 pt-3 border-t border-line/60 text-[11px] text-ink-faint/70 flex items-center gap-3">
      <span>${s.today.toFixed(3)} today</span>
      <span>·</span>
      <span>${s.total.toFixed(2)} total</span>
      {s.remaining != null && <><span>·</span><span>${s.remaining.toFixed(2)} left</span></>}
      {s.throttled && <span className="text-amber-600/70" title="New stories are generated less often while spend is high; conversation is unaffected.">· easing story frequency</span>}
    </div>
  );
}
