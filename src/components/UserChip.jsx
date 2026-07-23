import { useEffect, useRef, useState } from 'react';
import { api, currentUser, setCurrentUser } from '../lib/api.js';

// Unobtrusive current-user chip with a "switch person" menu. Sits in the header.
export default function UserChip({ onSwitch }) {
  const [users, setUsers] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const slug = currentUser();

  useEffect(() => { api.users().then(r => setUsers(r.users)).catch(() => {}); }, []);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const me = users.find(u => u.slug === slug);
  if (!me) return null;

  function switchTo(s) {
    setOpen(false);
    if (s === slug) return;
    setCurrentUser(s);
    onSwitch?.(s);
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)}
        className="w-8 h-8 rounded-full bg-jade-100 text-jade-700 flex items-center justify-center text-[13px] font-medium hover:ring-2 hover:ring-jade-200 transition-all"
        title={`Signed in as ${me.displayName}`}>
        {me.displayName?.[0]?.toUpperCase() || '?'}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-52 bg-white border border-line rounded-2xl shadow-lg p-1.5 z-30 animate-fade">
          <div className="px-2.5 py-1.5 text-[11px] text-ink-faint">Switch person</div>
          {users.map(u => (
            <button key={u.slug} onClick={() => switchTo(u.slug)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left text-[13px] transition-colors ${
                u.slug === slug ? 'bg-[#faf9f7] text-ink' : 'text-ink-soft hover:bg-[#faf9f7]'}`}>
              <span className="w-6 h-6 rounded-full bg-jade-100 text-jade-700 flex items-center justify-center text-[11px] font-medium">
                {u.displayName?.[0]?.toUpperCase() || '?'}
              </span>
              <span className="flex-1">{u.displayName}</span>
              {u.slug === slug && <span className="w-1.5 h-1.5 rounded-full bg-jade-400" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
