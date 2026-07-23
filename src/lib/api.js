// In a normal build the client talks to the Express API. In the static GitHub Pages
// demo build (VITE_STATIC=1) there is no backend: GET reads come from a baked JSON
// snapshot under <base>/demo/, and writes (review/onboarding) are local no-ops.
const STATIC = import.meta.env.VITE_STATIC === '1';
const BASE = import.meta.env.BASE_URL || '/';

export const isDemo = STATIC;

// The active local user (multi-user, no auth). Stored client-side and sent on every
// request so the backend routes to that user's databases.
const USER_KEY = 'mandarin.user';
export function currentUser() { try { return localStorage.getItem(USER_KEY) || ''; } catch { return ''; } }
export function setCurrentUser(slug) { try { slug ? localStorage.setItem(USER_KEY, slug) : localStorage.removeItem(USER_KEY); } catch {} }

async function req(path, opts) {
  const headers = { 'content-type': 'application/json' };
  const u = currentUser();
  if (u) headers['x-user'] = u;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts?.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function demo(file) {
  const res = await fetch(`${BASE}demo/${file}`);
  if (!res.ok) throw new Error(`demo ${file} ${res.status}`);
  return res.json();
}

let _dict = null;
async function demoLookup(term) {
  if (!_dict) _dict = await demo('dict.json');
  for (let len = Math.min(term.length, 4); len >= 1; len--) {
    const sub = term.slice(0, len);
    if (_dict[sub]?.length) return { term, results: _dict[sub] };
  }
  return { term, results: [] };
}

export const api = STATIC ? {
  meta: () => demo('meta.json'),
  home: () => demo('home.json'),
  session: () => demo('session.json'),
  lesson: () => demo('lesson.json'),
  lessonPlan: () => Promise.reject(new Error('no backend')),   // demo → exercise fallback
  lessonTurn: async () => ({ hanzi: '', english: 'Laoshi needs the local backend.', used: [] }),
  lessonComplete: async () => ({ outcomes: [], examples: 0, demo: true }),
  conversationPlan: () => Promise.reject(new Error('no backend')),
  conversationTurn: async () => ({ hanzi: '', english: 'Laoshi needs the local backend.', used: [] }),
  conversationComplete: async () => ({ outcomes: [], examples: 0, demo: true }),
  pronObserve: async () => ({ observed: 0, demo: true }),
  laoshiStatus: () => Promise.resolve({ available: false }),
  laoshi: async () => ({ hanzi: '老师功能需要本地后端。', pinyin: '', english: 'Laoshi needs the local backend.', note: '', demo: true }),
  modelBackground: async () => ({ ok: true, demo: true }),
  review: async () => ({ ok: true, demo: true }),          // no-op in demo
  stats: () => demo('stats.json'),
  evaluateThrottle: () => demo('stats.json').then(s => s.throttle),
  lookup: (term) => demoLookup(term),
  reading: () => demo('reading.json'),
  tone: () => demo('tone.json'),
  onboarding: () => Promise.resolve({ onboarded: true }),
  saveOnboarding: async () => ({ ok: true, demo: true }),
  modelSettings: () => Promise.resolve({ pref: 'fast', richAvailable: false, hasApiKey: false }),
  setModelPref: async (pref) => ({ pref, richAvailable: false }),
  users: () => Promise.resolve({ users: [{ slug: 'me', displayName: 'Demo', primary: true }], current: 'me', primary: 'me' }),
  addUser: async (displayName) => ({ user: { slug: 'demo', displayName }, users: [] }),
} : {
  meta: () => req('/api/meta'),
  home: () => req('/api/home'),
  session: () => req('/api/session'),
  lesson: (size = 16) => req('/api/lesson?size=' + size),
  lessonPlan: () => req('/api/lesson/plan'),
  lessonTurn: (body) => req('/api/lesson/turn', { method: 'POST', body: JSON.stringify(body) }),
  lessonComplete: (body) => req('/api/lesson/complete', { method: 'POST', body: JSON.stringify(body) }),
  conversationPlan: () => req('/api/conversation/plan'),
  conversationTurn: (body) => req('/api/conversation/turn', { method: 'POST', body: JSON.stringify(body) }),
  conversationComplete: (body) => req('/api/conversation/complete', { method: 'POST', body: JSON.stringify(body) }),
  pronObserve: (body) => req('/api/pron/observe', { method: 'POST', body: JSON.stringify(body) }),
  laoshiStatus: () => req('/api/laoshi/status'),
  laoshi: (body) => req('/api/laoshi', { method: 'POST', body: JSON.stringify(body) }),
  modelBackground: () => req('/api/model/background', { method: 'POST', body: '{}' }),
  review: (body) => req('/api/review', { method: 'POST', body: JSON.stringify(body) }),
  stats: () => req('/api/stats'),
  evaluateThrottle: (force = false) => req('/api/throttle/evaluate', { method: 'POST', body: JSON.stringify({ force }) }),
  lookup: (term) => req('/api/lookup?term=' + encodeURIComponent(term)),
  reading: () => req('/api/reading'),
  tone: (max = 10) => req('/api/tone?max=' + max),
  onboarding: () => req('/api/onboarding'),
  saveOnboarding: (body) => req('/api/onboarding', { method: 'POST', body: JSON.stringify(body) }),
  modelSettings: () => req('/api/settings/model'),
  setModelPref: (pref) => req('/api/settings/model', { method: 'POST', body: JSON.stringify({ pref }) }),
  users: () => req('/api/users'),
  addUser: (displayName) => req('/api/users', { method: 'POST', body: JSON.stringify({ displayName }) }),
};

// Audio: real media is only present with the backend. In the demo, playAudio falls
// back to speechSynthesis when the media URL 404s.
export const mediaUrl = (path) => (!path || STATIC ? null : '/media/' + encodeURIComponent(path));
