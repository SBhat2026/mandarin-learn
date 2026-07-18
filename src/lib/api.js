async function req(path, opts) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

export const api = {
  meta: () => req('/api/meta'),
  home: () => req('/api/home'),
  session: () => req('/api/session'),
  review: (body) => req('/api/review', { method: 'POST', body: JSON.stringify(body) }),
  stats: () => req('/api/stats'),
  evaluateThrottle: (force = false) => req('/api/throttle/evaluate', { method: 'POST', body: JSON.stringify({ force }) }),
  lookup: (term) => req('/api/lookup?term=' + encodeURIComponent(term)),
  reading: () => req('/api/reading'),
  tone: (max = 10) => req('/api/tone?max=' + max),
  onboarding: () => req('/api/onboarding'),
  saveOnboarding: (body) => req('/api/onboarding', { method: 'POST', body: JSON.stringify(body) }),
};

export const mediaUrl = (path) => (path ? '/media/' + encodeURIComponent(path) : null);
