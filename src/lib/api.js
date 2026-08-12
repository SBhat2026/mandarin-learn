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

// Shared-passphrase gate for the hosted instance (unused locally, where the
// server leaves it disabled). Kept beside the user slug so every request carries
// both automatically.
const ACCESS_KEY = 'mandarin.access';
export function accessToken() { try { return localStorage.getItem(ACCESS_KEY) || ''; } catch { return ''; } }
export function setAccessToken(v) { try { v ? localStorage.setItem(ACCESS_KEY, v) : localStorage.removeItem(ACCESS_KEY); } catch {} }

// Set when any request comes back 401 so the app can raise the gate.
let onLocked = null;
export function setLockHandler(fn) { onLocked = fn; }

export function authHeaders() {
  const h = {};
  const u = currentUser();
  if (u) h['x-user'] = u;
  const a = accessToken();
  if (a) h['x-access'] = a;
  return h;
}

async function req(path, opts) {
  const headers = { 'content-type': 'application/json', ...authHeaders() };
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts?.headers || {}) } });
  if (res.status === 401) { onLocked?.(); throw new Error('access required'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// Verify a passphrase against the server before storing it.
export async function verifyAccess(pass) {
  const r = await fetch('/api/auth/check', { headers: pass ? { 'x-access': pass } : {} });
  if (!r.ok) return { required: true, ok: false };
  return r.json();
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
  placement: async () => ({ taken: true, result: null }),   // demo: never offer the exam
  placementStart: async () => ({ probe: null }),
  placementAnswer: async () => ({ done: true, result: null }),
  placementSkip: async () => ({ done: true, skipped: true, result: null }),
  modelSettings: () => Promise.resolve({ pref: 'fast', richAvailable: false, hasApiKey: false }),
  setModelPref: async (pref) => ({ pref, richAvailable: false }),
  users: () => Promise.resolve({ users: [{ slug: 'me', displayName: 'Demo', primary: true }], current: 'me', primary: 'me' }),
  addUser: async (displayName) => ({ user: { slug: 'demo', displayName }, users: [] }),
  image: async () => ({ kind: 'none' }),
  signalChannel: async () => ({ ok: true }),
  signalChoice: async () => ({ ok: true }),
  familyNext: async () => ({ lesson: null }),
  familyOutcome: async () => ({ ok: true, demo: true }),
  story: async () => ({ story: null, demo: true }),
  storyOutcome: async () => ({ ok: true, demo: true }),
  prefs: async () => ({ pace: 5, topics: [] }),
  setPrefs: async (p) => ({ ...p, demo: true }),
  pinyinConvert: async () => ({ ok: false }),
  spend: async () => null,
} : {
  meta: () => req('/api/meta'),
  home: () => req('/api/home'),
  session: () => req('/api/session'),
  lesson: (size = 16) => req('/api/lesson?size=' + size),
  lessonPlan: () => req('/api/lesson/plan'),
  lessonTurn: (body) => req('/api/lesson/turn', { method: 'POST', body: JSON.stringify(body) }),
  lessonComplete: (body) => req('/api/lesson/complete', { method: 'POST', body: JSON.stringify(body) }),
  conversationPlan: () => req('/api/conversation/plan'),
  // body: { sessionId, history, userText, forceWrap? } — forceWrap asks the teacher
  // to close the conversation properly instead of the learner just walking away.
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
  placement: () => req('/api/placement'),
  placementStart: () => req('/api/placement/start', { method: 'POST', body: '{}' }),
  placementAnswer: (answer) => req('/api/placement/answer', { method: 'POST', body: JSON.stringify({ answer }) }),
  placementSkip: () => req('/api/placement/skip', { method: 'POST', body: '{}' }),
  modelSettings: () => req('/api/settings/model'),
  setModelPref: (pref) => req('/api/settings/model', { method: 'POST', body: JSON.stringify({ pref }) }),
  users: () => req('/api/users'),
  addUser: (displayName) => req('/api/users', { method: 'POST', body: JSON.stringify({ displayName }) }),
  image: (hanzi) => req('/api/image?hanzi=' + encodeURIComponent(hanzi)),
  signalChannel: (kind) => req('/api/signal/channel', { method: 'POST', body: JSON.stringify({ kind }) }),
  signalChoice: (correct) => req('/api/signal/choice', { method: 'POST', body: JSON.stringify({ correct }) }),
  familyNext: () => req('/api/family/next'),
  familyOutcome: (key, correct) => req('/api/family/outcome', { method: 'POST', body: JSON.stringify({ key, correct }) }),
  story: (fresh = false) => req('/api/reading/story' + (fresh ? '?fresh=1' : '')),
  storyOutcome: (body) => req('/api/reading/story/outcome', { method: 'POST', body: JSON.stringify(body) }),
  prefs: () => req('/api/prefs'),
  setPrefs: (body) => req('/api/prefs', { method: 'POST', body: JSON.stringify(body) }),
  pinyinConvert: (q) => req('/api/pinyin/convert?q=' + encodeURIComponent(q)),
  spend: () => req('/api/spend'),
};

// Audio: real media is only present with the backend. In the demo, playAudio falls
// back to speechSynthesis when the media URL 404s.
export const mediaUrl = (path) => (!path || STATIC ? null : '/media/' + encodeURIComponent(path));
