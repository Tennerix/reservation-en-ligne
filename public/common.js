// Fonctions partagées par index.html et prof.html
const TZ = 'Europe/Paris';
const JOURS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const ORDRE_JOURS = [1, 2, 3, 4, 5, 6, 0];
const MODE_LABEL = { visio: 'Visio', presentiel: 'Présentiel', les_deux: 'Visio ou présentiel' };

// Nombre de jours affichés à l'avance pour réserver
const JOURS_A_L_AVANCE = 21;

// Appel à l'API du site (même adresse, pas de configuration à faire)
async function api(method, path, data) {
  try {
    const r = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: data !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: data !== undefined ? JSON.stringify(data) : undefined
    });
    let j = null;
    try { j = await r.json(); } catch { /* pas de JSON */ }
    if (!r.ok) return { error: { message: (j && j.error) || 'Erreur ' + r.status } };
    return { data: j };
  } catch (e) {
    return { error: { message: 'Connexion impossible. Vérifie ta connexion internet.' } };
  }
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- Heures de Paris, quel que soit le fuseau du navigateur ----
function tzOffsetMin(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(new Date(ms));
  const g = k => +parts.find(p => p.type === k).value;
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUTC - ms) / 60000);
}

// Date/heure "murale" de Paris -> instant réel
function parisToDate(y, m, d, h, mi) {
  const guess = Date.UTC(y, m, d, h, mi);
  const off = tzOffsetMin(guess);
  let t = guess - off * 60000;
  const off2 = tzOffsetMin(t);
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}

// Jour actuel à Paris (m commence à 0)
function parisYMD(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date);
  const g = k => +parts.find(p => p.type === k).value;
  return { y: g('year'), m: g('month') - 1, d: g('day') };
}

const fmtJour = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const fmtHeure = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
function jourLabel(d) { const s = fmtJour.format(d); return s.charAt(0).toUpperCase() + s.slice(1); }
function heure(d) { return fmtHeure.format(d).replace(':', 'h'); }
function hhmm(t) { return String(t).slice(0, 5).replace(':', 'h'); }

function toast(msg, type = 'ok') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
