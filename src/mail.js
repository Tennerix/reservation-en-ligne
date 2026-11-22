// Envoi des e-mails (SMTP Gmail avec un mot de passe d'application),
// de la même façon que BeachStats. Pour passer plus tard à Cloudflare Email
// Service avec ton propre nom de domaine, seule la fonction sendMail change.
import { WorkerMailer } from 'worker-mailer';

const TZ = 'Europe/Paris';
const fmtJour = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const fmtHeure = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const ORDRE_JOURS = [1, 2, 3, 4, 5, 6, 0];
const MODE_LABEL = { visio: 'Visio', presentiel: 'Présentiel', les_deux: 'Visio ou présentiel' };

const quand = iso => {
  const d = new Date(iso);
  return fmtJour.format(d) + ' à ' + fmtHeure.format(d).replace(':', 'h');
};
const fmtFin = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const jusquau = ymd => ymd ? ", jusqu'au " + fmtFin.format(new Date(ymd + 'T00:00:00Z')) : '';
const hhmm = t => String(t).slice(0, 5).replace(':', 'h');
// Une valeur saisie par un élève ne doit jamais pouvoir ajouter de lignes à un e-mail
const une = s => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

export async function sendMail(env, to, subject, text) {
  if (env.MAIL_DEBUG === '1') {
    console.log('[MAIL_DEBUG]', to, '|', subject, '\n' + text);
    return;
  }
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    console.error("Envoi d'e-mail impossible : GMAIL_USER ou GMAIL_APP_PASSWORD manquant.");
    return;
  }
  const mailer = await WorkerMailer.connect({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    credentials: {
      username: env.GMAIL_USER,
      password: env.GMAIL_APP_PASSWORD.replace(/\s+/g, '')
    },
    authType: 'plain'
  });
  try {
    await mailer.send({
      from: { name: 'Cours particuliers', email: env.GMAIL_USER },
      to: { email: to },
      subject,
      text
    });
  } finally {
    await mailer.close();
  }
}

// Un échec d'e-mail ne doit jamais faire échouer la réservation
export function envoyer(ctx, env, to, subject, text) {
  ctx.waitUntil(
    sendMail(env, to, subject, text).catch(e => console.error("Échec de l'envoi d'un e-mail :", e && e.message))
  );
}

/* ---------- Réservation ---------- */

// r : { debut, matiere, mode, lieu, eleve_nom, eleve_email, eleve_tel, message, prof_nom, duree }
export function mailEleveReservation(r) {
  return {
    subject: 'Réservation confirmée : ' + quand(r.debut),
    text:
`Bonjour ${une(r.eleve_nom)},

Ta réservation est confirmée.

Matière : ${r.matiere}
Enseignant : ${r.prof_nom}
Date : ${quand(r.debut)} (${r.duree} min)
Format : ${MODE_LABEL[r.mode]}${r.mode === 'presentiel' && r.lieu ? '\nLieu : ' + r.lieu : ''}

${r.prof_nom} te contactera à cette adresse${r.mode === 'visio' ? " pour t'envoyer le lien de la visio" : ''}.

À bientôt !`
  };
}

export function mailProfReservation(r) {
  return {
    subject: 'Nouvelle réservation : ' + quand(r.debut),
    text:
`Bonjour ${r.prof_nom},

Un élève vient de réserver un cours.

Date : ${quand(r.debut)} (${r.duree} min)
Matière : ${r.matiere}
Format : ${MODE_LABEL[r.mode]}${r.mode === 'presentiel' && r.lieu ? '\nLieu : ' + r.lieu : ''}

Élève : ${une(r.eleve_nom)}
Email : ${une(r.eleve_email)}${r.eleve_tel ? '\nTéléphone : ' + une(r.eleve_tel) : ''}${r.message ? '\nMessage : ' + une(r.message) : ''}

Tu retrouves toutes tes réservations dans ton espace enseignant : ${r.site}/prof.html

(Tu reçois ce message car les notifications sont activées dans ton profil.)`
  };
}

/* ---------- Annulation ---------- */

export function mailEleveAnnulation(r) {
  return {
    subject: 'Cours annulé : ' + quand(r.debut),
    text:
`Bonjour ${une(r.eleve_nom)},

Ton cours de ${r.matiere} avec ${r.prof_nom} prévu le ${quand(r.debut)} a été annulé.

Tu peux réserver un autre créneau ici : ${r.site}/

Désolé pour la gêne.`
  };
}

export function mailProfAnnulation(r) {
  return {
    subject: 'Réservation annulée : ' + quand(r.debut),
    text:
`Bonjour ${r.prof_nom},

Tu as annulé la réservation suivante. Le créneau est de nouveau disponible.

Date : ${quand(r.debut)}
Matière : ${r.matiere}
Élève : ${une(r.eleve_nom)} (${une(r.eleve_email)}) ; il a reçu un e-mail d'annulation.

(Tu reçois ce message car les notifications sont activées dans ton profil.)`
  };
}

/* ---------- Disponibilités ---------- */

export function mailProfDispos(prof_nom, dispos, site) {
  const tri = [...dispos].sort((a, b) => ORDRE_JOURS.indexOf(a.jour) - ORDRE_JOURS.indexOf(b.jour) || a.debut.localeCompare(b.debut));
  const liste = tri.length
    ? tri.map(d => `- ${JOURS[d.jour]} de ${hhmm(d.debut)} à ${hhmm(d.fin)} (${MODE_LABEL[d.mode]}${d.lieu ? ', ' + d.lieu : ''}${jusquau(d.valide_au)})`).join('\n')
    : "Aucune plage pour l'instant.";
  return {
    subject: 'Tes disponibilités ont été mises à jour',
    text:
`Bonjour ${prof_nom},

Tes disponibilités viennent d'être modifiées. Voici ce que voient les élèves :

${liste}

Tu peux les modifier ici : ${site}/prof.html

(Tu reçois ce message car les notifications sont activées dans ton profil.)`
  };
}
