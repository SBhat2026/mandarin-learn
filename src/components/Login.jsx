import { useEffect, useState } from 'react';
import { api, setCurrentUser } from '../lib/api.js';

// The dead-simple "who's here?" picker (no auth, up to 5 people). Shown on load when
// no user is chosen yet. Picking a name stores it client-side and enters the app.
export default function Login({ onPick }) {
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { api.users().then(r => setUsers(r.users)).catch(() => setUsers([])); }, []);

  function pick(slug) { setCurrentUser(slug); onPick(slug); }

  async function add(e) {
    e?.preventDefault();
    const n = name.trim();
    if (!n) return;
    setErr('');
    try { const r = await api.addUser(n); pick(r.user.slug); }
    catch (e) { setErr(e.message); }
  }

  const atCap = (users?.length || 0) >= 5;

  return (
    <div className="min-h-screen flex items-center justify-center px-5 bg-[#faf9f7]">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="hanzi text-[42px] leading-none text-ink mb-2">学</div>
          <h1 className="text-[19px] font-medium text-ink">Who’s here?</h1>
          <p className="text-[13px] text-ink-faint mt-1">Pick your name to pick up where you left off.</p>
        </div>

        <div className="space-y-2">
          {(users || []).map(u => (
            <button key={u.slug} onClick={() => pick(u.slug)}
              className="w-full flex items-center gap-3 p-3 bg-white border border-line rounded-2xl hover:border-ink/30 transition-colors text-left">
              <span className="w-10 h-10 rounded-full bg-jade-100 text-jade-700 flex items-center justify-center text-[16px] font-medium">
                {u.displayName?.[0]?.toUpperCase() || '?'}
              </span>
              <span className="flex-1">
                <span className="block text-[14px] font-medium text-ink">{u.displayName}</span>
                {u.primary && <span className="text-[11px] text-ink-faint">your original progress</span>}
              </span>
              <span className="text-ink-faint">→</span>
            </button>
          ))}

          {!adding && !atCap && (
            <button onClick={() => setAdding(true)}
              className="w-full p-3 rounded-2xl border border-dashed border-line text-[13px] text-ink-soft hover:text-ink hover:border-ink/30 transition-colors">
              + Add a person
            </button>
          )}
          {adding && (
            <form onSubmit={add} className="flex gap-2">
              <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Name"
                className="flex-1 px-3.5 py-2.5 bg-white border border-line rounded-2xl text-[14px] outline-none focus:border-ink/30" />
              <button type="submit" className="px-4 py-2.5 rounded-2xl bg-ink text-white text-[13px] font-medium">Go</button>
            </form>
          )}
          {atCap && <p className="text-[11.5px] text-ink-faint text-center pt-1">Up to 5 people on this device.</p>}
          {err && <p className="text-[12px] text-amber-600 text-center pt-1">{err}</p>}
        </div>
      </div>
    </div>
  );
}
