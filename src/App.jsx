import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api, isDemo } from './lib/api.js';
import Home from './pages/Home.jsx';
import Session from './pages/Session.jsx';
import ToneTrainer from './pages/ToneTrainer.jsx';
import Reading from './pages/Reading.jsx';
import Stats from './pages/Stats.jsx';
import Onboarding from './pages/Onboarding.jsx';
import SettingsGear from './components/SettingsGear.jsx';

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
  const navigate = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    api.meta().then(m => {
      setMeta(m);
      if (!m.onboarding?.onboarded && m.counts.units > 0) navigate('/onboarding');
    }).catch(() => setMeta({ error: true }));
  }, []);

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
            <div className="ml-auto"><SettingsGear /></div>
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
      </main>
    </div>
  );
}
