// store.js — что живёт в localStorage: зал славы и свои классы. Ни DOM, ни сети.

export function loadCustomClasses() {
  try {
    const raw = JSON.parse(localStorage.getItem('dnd_custom_classes') || '[]');
    return Array.isArray(raw) ? raw.filter(c => c && c.name) : [];
  } catch { return []; }
}

export function saveCustomClasses(list) {
  localStorage.setItem('dnd_custom_classes', JSON.stringify(list.slice(0, 12)));
}

export function loadHof() {
  try { return JSON.parse(localStorage.getItem('dnd_hof') || '[]'); } catch { return []; }
}

export function saveHofEntry(entry) {
  const hof = loadHof();
  hof.unshift(entry);
  localStorage.setItem('dnd_hof', JSON.stringify(hof.slice(0, 20)));
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Код комнаты из ссылки-приглашения (?join=ABCD) или null, если ссылка битая. */
export function parseInvite(search) {
  try {
    const code = new URLSearchParams(search || '').get('join');
    return code && /^[a-z0-9]{4}$/i.test(code) ? code.toUpperCase() : null;
  } catch { return null; }
}
