// Worker Cloudflare : API de réservation de cours particuliers (remplace Supabase)
// Les pages (dossier public/) sont servies directement par Cloudflare ;
// ce Worker ne répond qu'aux adresses /api/*.

import {
  envoyer, mailEleveReservation, mailProfReservation, mailEleveAnnulation, mailProfAnnulation, mailProfDispos,
  mailEleveLien, mailEleveAnnulationParEleve, mailProfAnnulationParEleve, mailProfContact
} from './mail.js';

const TZ = 'Europe/Paris';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MODES = ['visio', 'presentiel', 'les_deux'];
const CATEGORIES = ['Scolaire', 'Sport', 'Autre'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const LIEN_ELEVE_MS = 60 * 24 * 3600 * 1000;   // validité du lien personnel de l'élève
const DELAI_ANNULATION_H = 24;                  // l'élève peut annuler seul jusqu'à 24 h avant
const MAX_CONTACTS = 3;                         // messages au prof par réservation

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = m => new HttpError(400, m);

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      // Protection contre les requêtes venues d'un autre site
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const o = req.headers.get('origin');
        if (o && new URL(o).host !== url.host) throw new HttpError(403, 'Origine refusée');
      }
      return await route(req, env, url, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Erreur du serveur' }, 500);
    }
  }
};

async function body(req) {
  try {
    const b = await req.json();
    if (b && typeof b === 'object') return b;
  } catch { /* corps invalide */ }
  throw bad('Requête invalide');
}

const str = (v, min, max, label) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw bad(label + ' invalide');
  return s;
};
const optStr = (v, max, label) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > max) throw bad(label + ' trop long');
  return s || null;
};

/* ---------------- Routes ---------------- */

async function route(req, env, url, ctx) {
  const m = req.method;
  const p = url.pathname.replace(/\/+$/, '');
  let r;

  // ----- Public (élèves) -----
  if (m === 'GET' && p === '/api/public') return publicData(env);
  if (m === 'GET' && p === '/api/pris') return creneauxPris(env, url);
  if (m === 'POST' && p === '/api/reserver') return reserver(env, ctx, url, await body(req));

  // ----- Tableau de bord élève (lien personnel reçu par e-mail) -----
  if (m === 'POST' && p === '/api/eleve/lien') return eleveDemandeLien(env, ctx, url, await body(req));
  if (m === 'GET' && p === '/api/eleve/reservations') return eleveReservations(env, url);
  if (m === 'POST' && p === '/api/eleve/annuler') return eleveAnnuler(env, ctx, url, await body(req));
  if (m === 'POST' && p === '/api/eleve/contacter') return eleveContacter(env, ctx, url, await body(req));

  // ----- Comptes -----
  if (m === 'POST' && p === '/api/register') return register(req, env, url, await body(req));
  if (m === 'POST' && p === '/api/login') return login(req, env, url, await body(req));
  if (m === 'POST' && p === '/api/logout') return logout(req, env, url);

  // ----- Espace enseignant (connexion obligatoire) -----
  if (p.startsWith('/api/')) {
    const user = await currentUser(req, env);
    if (p === '/api/me' && m === 'GET') {
      if (!user) return json({ user: null });
      const profil = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(user.id).first();
      return json({ user, profil: profil || null });
    }
    if (!user) throw new HttpError(401, 'Connexion requise');

    if (p === '/api/profil' && m === 'POST') return creerProfil(env, user, await body(req));
    if (p === '/api/profil' && m === 'PUT') return majProfil(env, user, await body(req));
    if (p === '/api/prof' && m === 'GET') return donneesProf(env, user);
    if (p === '/api/dispos' && m === 'POST') return ajouterDispo(env, ctx, url, user, await body(req));
    if (p === '/api/prof/matieres' && m === 'PUT') return enregistrerMatieres(env, user, await body(req));
    if (p === '/api/matieres' && m === 'POST') return ajouterMatiere(env, await body(req));
    if ((r = p.match(/^\/api\/dispos\/([\w-]+)$/)) && m === 'DELETE') {
      const del = await env.DB.prepare('DELETE FROM disponibilites WHERE id = ? AND prof_id = ?').bind(r[1], user.id).run();
      if (del.meta.changes) await notifierDispos(env, ctx, url, user);
      return json({ ok: true });
    }
    if ((r = p.match(/^\/api\/reservations\/([\w-]+)\/annuler$/)) && m === 'POST') return annuler(env, ctx, url, user, r[1]);
  }
  throw new HttpError(404, 'Introuvable');
}

/* ---------------- Public ---------------- */

async function publicData(env) {
  const [mat, pm, dispos] = await env.DB.batch([
    env.DB.prepare('SELECT id, nom, categorie FROM matieres ORDER BY nom'),
    env.DB.prepare(`SELECT pm.prof_id, pm.matiere_id, pm.tarif, p.nom, p.bio, p.duree_creneau
                    FROM prof_matieres pm JOIN profiles p ON p.id = pm.prof_id`),
    env.DB.prepare('SELECT id, prof_id, jour, debut, fin, mode, lieu, valide_du, valide_au FROM disponibilites WHERE valide_au IS NULL OR valide_au >= ?')
      .bind(parisParts(new Date()).date)
  ]);
  return json({
    matieres: mat.results,
    pm: pm.results.map(x => ({
      prof_id: x.prof_id, matiere_id: x.matiere_id, tarif: x.tarif,
      profiles: { nom: x.nom, bio: x.bio, duree_creneau: x.duree_creneau }
    })),
    dispos: dispos.results
  });
}

// Créneaux déjà pris, sans aucune info personnelle
async function creneauxPris(env, url) {
  const a = new Date(url.searchParams.get('from') || ''), b = new Date(url.searchParams.get('to') || '');
  if (isNaN(a) || isNaN(b) || b - a > 120 * 86400000 || b < a) throw bad('Période invalide');
  const { results } = await env.DB.prepare(
    "SELECT prof_id, debut, fin FROM reservations WHERE statut = 'confirme' AND debut < ?1 AND fin > ?2"
  ).bind(b.toISOString(), a.toISOString()).all();
  return json(results);
}

const parisFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit'
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function parisParts(d) {
  const o = {};
  for (const x of parisFmt.formatToParts(d)) o[x.type] = x.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour}:${o.minute}`, dow: DOW[o.weekday] };
}

// Tout est revérifié côté serveur, comme la fonction reserver() de l'ancienne version
async function reserver(env, ctx, url, b) {
  const mode = b.mode;
  if (mode !== 'visio' && mode !== 'presentiel') throw bad('Mode invalide');
  const nom = typeof b.nom === 'string' ? b.nom.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (nom.length < 2 || nom.length > 80 || !EMAIL_RE.test(email) || email.length > 120) throw bad('Nom ou email invalide');
  const tel = optStr(b.tel, 30, 'Téléphone');
  const message = optStr(b.message, 500, 'Message');

  const debut = new Date(b.debut);
  const matiere = Number(b.matiere);
  if (isNaN(debut) || !Number.isInteger(matiere) || typeof b.prof !== 'string') throw bad('Requête invalide');
  const now = Date.now();
  if (debut.getTime() < now + 2 * 3600e3 || debut.getTime() > now + 90 * 86400e3) throw bad("Ce créneau n'est plus disponible");

  // Anti-abus : l'adresse saisie reçoit un e-mail, on limite donc les réservations par adresse
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM reservations WHERE lower(eleve_email) = lower(?) AND created_at > datetime(\'now\', \'-1 day\')'
  ).bind(email).first();
  if (recent && recent.n >= 5) throw new HttpError(429, 'Trop de réservations avec cette adresse aujourd\'hui. Réessaie demain.');

  const prof = await env.DB.prepare(
    'SELECT p.nom, p.duree_creneau, p.notif_email, u.email AS prof_email FROM profiles p JOIN users u ON u.id = p.id WHERE p.id = ?'
  ).bind(b.prof).first();
  if (!prof) throw bad('Enseignant introuvable');
  const okMat = await env.DB.prepare('SELECT 1 FROM prof_matieres WHERE prof_id = ? AND matiere_id = ?').bind(b.prof, matiere).first();
  if (!okMat) throw bad('Matière non proposée par cet enseignant');

  const fin = new Date(debut.getTime() + prof.duree_creneau * 60000);
  const a = parisParts(debut), z = parisParts(fin);
  const dispos = (await env.DB.prepare('SELECT debut, fin, mode, lieu, valide_du, valide_au FROM disponibilites WHERE prof_id = ? AND jour = ?')
    .bind(b.prof, a.dow).all()).results;
  const dispoOk = a.date === z.date ? dispos.find(d =>
    d.debut <= a.hm && d.fin >= z.hm && (d.mode === mode || d.mode === 'les_deux')
    && (!d.valide_du || a.date >= d.valide_du) && (!d.valide_au || a.date <= d.valide_au)) : null;
  if (!dispoOk) throw bad("Ce créneau n'est pas proposé");

  // Insertion atomique : refusée si le créneau chevauche une réservation confirmée
  const id = crypto.randomUUID();
  const res = await env.DB.prepare(`
    INSERT INTO reservations (id, prof_id, matiere_id, debut, fin, mode, eleve_nom, eleve_email, eleve_tel, message)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
    WHERE NOT EXISTS (
      SELECT 1 FROM reservations
      WHERE prof_id = ?2 AND statut = 'confirme' AND debut < ?5 AND fin > ?4
    )`).bind(id, b.prof, matiere, debut.toISOString(), fin.toISOString(), mode, nom, email, tel, message).run();
  if (!res.meta.changes) throw new HttpError(409, "Ce créneau vient d'être pris");

  // E-mails (en arrière-plan, sans retarder ni faire échouer la réservation)
  const nomMatiere = (await env.DB.prepare('SELECT nom FROM matieres WHERE id = ?').bind(matiere).first())?.nom || '';
  const info = {
    debut: debut.toISOString(), matiere: nomMatiere, mode, lieu: dispoOk.lieu, duree: prof.duree_creneau,
    eleve_nom: nom, eleve_email: email, eleve_tel: tel, message, prof_nom: prof.nom, site: url.origin
  };
  info.lien_url = url.origin + '/mes-reservations.html?t=' + await creerLienEleve(env, email);
  const mEleve = mailEleveReservation(info);
  envoyer(ctx, env, email, mEleve.subject, mEleve.text);
  if (prof.notif_email) {
    const mProf = mailProfReservation(info);
    envoyer(ctx, env, prof.prof_email, mProf.subject, mProf.text);
  }
  return json({ id });
}

/* ---------------- Tableau de bord élève ---------------- */

// Lien personnel : un jeton aléatoire envoyé par e-mail (seul son hachage est gardé en base)
async function creerLienEleve(env, email) {
  const buf = crypto.getRandomValues(new Uint8Array(24));
  const token = toHex(buf);
  await env.DB.prepare('INSERT INTO eleve_liens (token_hash, email, expire_at) VALUES (?, lower(?), ?)')
    .bind(await sha256Hex(token), email, Date.now() + LIEN_ELEVE_MS).run();
  return token;
}

async function emailDuLien(env, t) {
  if (typeof t !== 'string' || !/^[0-9a-f]{48}$/.test(t)) throw new HttpError(401, 'Lien invalide ou expiré');
  const r = await env.DB.prepare('SELECT email FROM eleve_liens WHERE token_hash = ? AND expire_at > ?')
    .bind(await sha256Hex(t), Date.now()).first();
  if (!r) throw new HttpError(401, 'Lien invalide ou expiré');
  return r.email;
}

// Réponse identique que l'adresse existe ou non, pour ne rien révéler
async function eleveDemandeLien(env, ctx, url, b) {
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!EMAIL_RE.test(email) || email.length > 120) throw bad('Adresse e-mail invalide');
  const a = await env.DB.prepare('SELECT COUNT(*) AS n FROM reservations WHERE lower(eleve_email) = lower(?)').bind(email).first();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM eleve_liens WHERE email = lower(?) AND expire_at > ?')
    .bind(email, Date.now() + LIEN_ELEVE_MS - 3600e3).first();   // liens créés depuis moins d'une heure
  if (a && a.n > 0 && recent && recent.n < 3) {
    const mail = mailEleveLien({ lien_url: url.origin + '/mes-reservations.html?t=' + await creerLienEleve(env, email) });
    envoyer(ctx, env, email, mail.subject, mail.text);
  }
  return json({ ok: true });
}

async function eleveReservations(env, url) {
  const email = await emailDuLien(env, url.searchParams.get('t'));
  const rows = (await env.DB.prepare(
    `SELECT r.id, r.debut, r.fin, r.mode, r.statut, r.eleve_nom, r.contacts, m.nom AS matiere, p.nom AS prof_nom
     FROM reservations r JOIN matieres m ON m.id = r.matiere_id JOIN profiles p ON p.id = r.prof_id
     WHERE lower(r.eleve_email) = ? ORDER BY r.debut DESC LIMIT 100`
  ).bind(email).all()).results;
  const lim = Date.now() + DELAI_ANNULATION_H * 3600e3;
  return json({
    email, delai: DELAI_ANNULATION_H, max_contacts: MAX_CONTACTS,
    reservations: rows.map(r => ({ ...r, peut_annuler: r.statut === 'confirme' && new Date(r.debut).getTime() >= lim,
      a_venir: new Date(r.fin).getTime() > Date.now() }))
  });
}

async function reservationEleve(env, email, id) {
  if (typeof id !== 'string') throw bad('Requête invalide');
  const r = await env.DB.prepare(
    `SELECT r.id, r.prof_id, r.debut, r.fin, r.mode, r.statut, r.contacts, r.eleve_nom, r.eleve_email,
            m.nom AS matiere, p.nom AS prof_nom, p.notif_email, u.email AS prof_email
     FROM reservations r JOIN matieres m ON m.id = r.matiere_id JOIN profiles p ON p.id = r.prof_id JOIN users u ON u.id = r.prof_id
     WHERE r.id = ? AND lower(r.eleve_email) = ?`
  ).bind(id, email).first();
  if (!r) throw new HttpError(404, 'Réservation introuvable');
  return r;
}

async function eleveAnnuler(env, ctx, url, b) {
  const email = await emailDuLien(env, b.t);
  const r = await reservationEleve(env, email, b.id);
  if (r.statut !== 'confirme') return json({ ok: true });
  if (new Date(r.debut).getTime() < Date.now() + DELAI_ANNULATION_H * 3600e3)
    throw bad(`Il reste moins de ${DELAI_ANNULATION_H} h avant ce cours : écris directement à ${r.prof_nom} avec le bouton « Contacter ».`);
  const upd = await env.DB.prepare("UPDATE reservations SET statut = 'annule' WHERE id = ? AND statut = 'confirme'").bind(r.id).run();
  if (!upd.meta.changes) return json({ ok: true });
  const info = { ...r, site: url.origin };
  const mEleve = mailEleveAnnulationParEleve(info);
  envoyer(ctx, env, r.eleve_email, mEleve.subject, mEleve.text);
  if (r.notif_email) {
    const mProf = mailProfAnnulationParEleve(info);
    envoyer(ctx, env, r.prof_email, mProf.subject, mProf.text);
  }
  return json({ ok: true });
}

async function eleveContacter(env, ctx, url, b) {
  const email = await emailDuLien(env, b.t);
  const message = str(b.message, 3, 1000, 'Message');
  const r = await reservationEleve(env, email, b.id);
  if (r.statut !== 'confirme') throw bad('Cette réservation est déjà annulée.');
  if (r.contacts >= MAX_CONTACTS) throw new HttpError(429, 'Tu as déjà envoyé plusieurs messages pour ce cours. Attends la réponse de ' + r.prof_nom + '.');
  await env.DB.prepare('UPDATE reservations SET contacts = contacts + 1 WHERE id = ?').bind(r.id).run();
  const mail = mailProfContact({ ...r, message, site: url.origin });
  envoyer(ctx, env, r.prof_email, mail.subject, mail.text, r.eleve_email);
  return json({ ok: true });
}

/* ---------------- Comptes ---------------- */

const enc = new TextEncoder();
const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const toHex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');

async function pbkdf2(pass, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
}
async function hashPass(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return toB64(salt) + '$' + toB64(await pbkdf2(pass, salt));
}
async function checkPass(pass, stored) {
  const [s, h] = stored.split('$');
  const got = new Uint8Array(await pbkdf2(pass, fromB64(s)));
  const want = fromB64(h);
  let diff = got.length ^ want.length;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ (want[i] || 0);
  return diff === 0;
}
const sha256Hex = async s => toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

function cookie(url, value, maxAge) {
  return `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` + (url.protocol === 'https:' ? '; Secure' : '');
}

async function newSession(env, url, userId) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256Hex(token), userId, Date.now() + SESSION_MS)
  ]);
  return cookie(url, token, SESSION_MS / 1000);
}

async function currentUser(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  if (!m) return null;
  return await env.DB.prepare(
    `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256Hex(m[1]), Date.now()).first();
}

async function register(req, env, url, b) {
  const email = (typeof b.email === 'string' ? b.email.trim().toLowerCase() : '');
  const pass = typeof b.password === 'string' ? b.password : '';
  if (!EMAIL_RE.test(email) || email.length > 120) throw bad('Adresse email invalide.');
  if (pass.length < 8 || pass.length > 200) throw bad('Le mot de passe doit faire 8 caractères minimum.');
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare('INSERT INTO users (id, email, pass) VALUES (?, ?, ?)').bind(id, email, await hashPass(pass)).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message || e))) throw new HttpError(409, 'Un compte existe déjà avec cet email.');
    throw e;
  }
  return json({ user: { id, email } }, 200, { 'set-cookie': await newSession(env, url, id) });
}

async function login(req, env, url, b) {
  const email = (typeof b.email === 'string' ? b.email.trim().toLowerCase() : '');
  const pass = typeof b.password === 'string' ? b.password : '';
  const now = Date.now();
  const att = await env.DB.prepare('SELECT n, first_at FROM login_attempts WHERE email = ?').bind(email).first();
  if (att && now - att.first_at < 15 * 60000 && att.n >= 8) throw new HttpError(429, 'Trop d\'essais. Réessaie dans quelques minutes.');

  const u = await env.DB.prepare('SELECT id, email, pass FROM users WHERE email = ?').bind(email).first();
  // Même durée de calcul que l'email existe ou non
  const ok = u ? await checkPass(pass, u.pass) : (await pbkdf2(pass, new Uint8Array(16)), false);
  if (!ok) {
    await env.DB.prepare(`INSERT INTO login_attempts (email, n, first_at) VALUES (?1, 1, ?2)
      ON CONFLICT(email) DO UPDATE SET
        n = CASE WHEN ?2 - first_at >= 900000 THEN 1 ELSE n + 1 END,
        first_at = CASE WHEN ?2 - first_at >= 900000 THEN ?2 ELSE first_at END`).bind(email, now).run();
    throw new HttpError(401, 'Email ou mot de passe incorrect.');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE email = ?').bind(email).run();
  return json({ user: { id: u.id, email: u.email } }, 200, { 'set-cookie': await newSession(env, url, u.id) });
}

async function logout(req, env, url) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(m[1])).run();
  return json({ ok: true }, 200, { 'set-cookie': cookie(url, '', 0) });
}

/* ---------------- Espace enseignant ---------------- */

async function creerProfil(env, user, b) {
  const nom = str(b.nom, 2, 80, 'Nom');
  try {
    await env.DB.prepare('INSERT INTO profiles (id, nom) VALUES (?, ?)').bind(user.id, nom).run();
  } catch (e) {
    if (/UNIQUE|PRIMARY/i.test(String(e.message || e))) throw new HttpError(409, 'Profil déjà créé');
    throw e;
  }
  return json({ ok: true });
}

async function majProfil(env, user, b) {
  const nom = str(b.nom, 2, 80, 'Nom');
  const bio = optStr(b.bio, 500, 'Présentation');
  const duree = Number(b.duree_creneau);
  if (!Number.isInteger(duree) || duree < 15 || duree > 240) throw bad('La durée doit être entre 15 et 240 minutes.');
  const notif = b.notif_email ? 1 : 0;
  await env.DB.prepare('UPDATE profiles SET nom = ?, bio = ?, duree_creneau = ?, notif_email = ? WHERE id = ?').bind(nom, bio, duree, notif, user.id).run();
  const profil = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(user.id).first();
  return json({ profil });
}

async function donneesProf(env, user) {
  const [mat, pm, dispos, res] = await env.DB.batch([
    env.DB.prepare('SELECT id, nom, categorie FROM matieres ORDER BY nom'),
    env.DB.prepare('SELECT prof_id, matiere_id, tarif FROM prof_matieres WHERE prof_id = ?').bind(user.id),
    env.DB.prepare('SELECT * FROM disponibilites WHERE prof_id = ? ORDER BY debut').bind(user.id),
    env.DB.prepare(`SELECT r.*, m.nom AS matiere_nom FROM reservations r JOIN matieres m ON m.id = r.matiere_id
                    WHERE r.prof_id = ? AND r.statut = 'confirme' AND r.fin >= ? ORDER BY r.debut`)
      .bind(user.id, new Date().toISOString())
  ]);
  return json({
    matieres: mat.results, pm: pm.results, dispos: dispos.results,
    res: res.results.map(r => ({ ...r, matieres: { nom: r.matiere_nom } }))
  });
}

async function ajouterDispo(env, ctx, url, user, b) {
  const jour = Number(b.jour);
  if (!Number.isInteger(jour) || jour < 0 || jour > 6) throw bad('Jour invalide');
  if (!HM_RE.test(b.debut) || !HM_RE.test(b.fin) || b.fin <= b.debut) throw bad("L'heure de fin doit être après l'heure de début.");
  if (!MODES.includes(b.mode)) throw bad('Format invalide');
  const lieu = optStr(b.lieu, 120, 'Lieu');
  const { du, au } = periodeValidite(b.duree, b.jusqua);
  // Chevauchement : même jour, mêmes heures ET périodes de validité qui se recoupent
  const chev = await env.DB.prepare(
    `SELECT 1 FROM disponibilites WHERE prof_id = ?1 AND jour = ?2 AND debut < ?4 AND fin > ?3
       AND COALESCE(valide_du, '0000-01-01') <= ?6 AND COALESCE(valide_au, '9999-12-31') >= ?5`
  ).bind(user.id, jour, b.debut, b.fin, du || '0000-01-01', au || '9999-12-31').first();
  if (chev) throw bad('Cette plage chevauche une plage existante le même jour et la même période.');
  await env.DB.prepare('INSERT INTO disponibilites (id, prof_id, jour, debut, fin, mode, lieu, valide_du, valide_au) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), user.id, jour, b.debut, b.fin, b.mode, lieu, du, au).run();
  await notifierDispos(env, ctx, url, user);
  return json({ ok: true });
}

// Remplace la liste des matières de l'enseignant par celle reçue
async function enregistrerMatieres(env, user, b) {
  if (!Array.isArray(b.items) || b.items.length > 100) throw bad('Requête invalide');
  const stmts = [env.DB.prepare('DELETE FROM prof_matieres WHERE prof_id = ?').bind(user.id)];
  for (const it of b.items) {
    const id = Number(it.matiere_id);
    const tarif = it.tarif === null || it.tarif === '' || it.tarif === undefined ? null : Number(it.tarif);
    if (!Number.isInteger(id) || (tarif !== null && !(tarif >= 0 && tarif <= 1000))) throw bad('Matière ou tarif invalide');
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO prof_matieres (prof_id, matiere_id, tarif) VALUES (?, ?, ?)').bind(user.id, id, tarif));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (/FOREIGN/i.test(String(e.message || e))) throw bad('Matière inconnue');
    throw e;
  }
  return json({ ok: true });
}

async function ajouterMatiere(env, b) {
  const nom = str(b.nom, 2, 40, 'Nom');
  if (!CATEGORIES.includes(b.categorie)) throw bad('Catégorie invalide');
  try {
    await env.DB.prepare('INSERT INTO matieres (nom, categorie) VALUES (?, ?)').bind(nom, b.categorie).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message || e))) throw new HttpError(409, 'Cette matière existe déjà dans la liste.');
    throw e;
  }
  return json({ ok: true });
}

/* ---------------- E-mails de l'enseignant ---------------- */

// Récapitulatif des disponibilités, si l'enseignant a activé les notifications
async function notifierDispos(env, ctx, url, user) {
  const p = await env.DB.prepare('SELECT nom, notif_email FROM profiles WHERE id = ?').bind(user.id).first();
  if (!p || !p.notif_email) return;
  const { results } = await env.DB.prepare('SELECT jour, debut, fin, mode, lieu, valide_au FROM disponibilites WHERE prof_id = ? AND (valide_au IS NULL OR valide_au >= ?)')
    .bind(user.id, parisParts(new Date()).date).all();
  const m = mailProfDispos(p.nom, results, url.origin);
  envoyer(ctx, env, user.email, m.subject, m.text);
}

// Annulation par l'enseignant : l'élève est toujours prévenu ; l'enseignant reçoit une copie s'il l'a activé
async function annuler(env, ctx, url, user, id) {
  const r = await env.DB.prepare(
    `SELECT r.debut, r.mode, r.eleve_nom, r.eleve_email, m.nom AS matiere, p.nom AS prof_nom, p.notif_email
     FROM reservations r JOIN matieres m ON m.id = r.matiere_id JOIN profiles p ON p.id = r.prof_id
     WHERE r.id = ? AND r.prof_id = ? AND r.statut = 'confirme'`
  ).bind(id, user.id).first();
  if (!r) return json({ ok: true });
  const upd = await env.DB.prepare("UPDATE reservations SET statut = 'annule' WHERE id = ? AND prof_id = ? AND statut = 'confirme'")
    .bind(id, user.id).run();
  if (!upd.meta.changes) return json({ ok: true });
  const info = { ...r, site: url.origin };
  const mEleve = mailEleveAnnulation(info);
  envoyer(ctx, env, r.eleve_email, mEleve.subject, mEleve.text);
  if (r.notif_email) {
    const mProf = mailProfAnnulation(info);
    envoyer(ctx, env, user.email, mProf.subject, mProf.text);
  }
  return json({ ok: true });
}

/* ---------------- Période de validité d'une plage ---------------- */

const addJours = (ymd, n) => {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Renvoie { du, au } (dates de Paris, AAAA-MM-JJ ; null = sans limite)
function periodeValidite(duree, jusqua) {
  const t = parisParts(new Date());          // aujourd'hui à Paris
  const [y, m] = t.date.split('-').map(Number);
  switch (duree) {
    case undefined:
    case null:
    case 'illimite': return { du: null, au: null };
    case 'semaine':  return { du: t.date, au: addJours(t.date, (7 - t.dow) % 7) };   // jusqu'à dimanche
    case 'semaine_pro': {   // lundi → dimanche de la semaine prochaine
      const lundi = addJours(t.date, ((8 - t.dow) % 7) || 7);
      return { du: lundi, au: addJours(lundi, 6) };
    }
    case 'mois':     return { du: t.date, au: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
    case 'annee':    return { du: t.date, au: y + '-12-31' };
    case 'date': {
      if (typeof jusqua !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(jusqua) || isNaN(new Date(jusqua + 'T00:00:00Z')))
        throw bad('Choisis une date de fin valide.');
      if (jusqua < t.date) throw bad('La date de fin est déjà passée.');
      if (jusqua > addJours(t.date, 800)) throw bad('La date de fin est trop lointaine.');
      return { du: t.date, au: jusqua };
    }
    default: throw bad('Durée invalide');
  }
}
