# Réservation de cours particuliers (version Cloudflare)

Tout tourne sur Cloudflare : pages, API (Worker) et base de données (D1).

- `public/index.html` : la page des élèves (matière, visio ou présentiel, créneau).
- `public/prof.html` : l'espace des enseignants (compte, matières, disponibilités, réservations, profil).
- `src/worker.js` : l'API (comptes, créneaux, réservation).
- `src/mail.js` : l'envoi des e-mails.
- `schema.sql` : la structure de la base D1 (pour une installation neuve).
- `wrangler.toml` : la configuration Cloudflare.

## Mise en ligne

Dans le dossier, avec Node.js installé :

1. `npm install`
2. `npx wrangler login` (une seule fois par ordinateur)
3. `npx wrangler deploy`

## E-mails

Le site envoie des e-mails par Gmail (comme BeachStats), avec un mot de passe d'application Google. À configurer une seule fois, dans ce dossier :

1. `npx wrangler secret put GMAIL_USER` : colle l'adresse Gmail qui enverra les mails.
2. `npx wrangler secret put GMAIL_APP_PASSWORD` : colle le mot de passe d'application (16 lettres).

Ces deux valeurs sont stockées par Cloudflare, jamais dans les fichiers. Tant qu'elles ne sont pas définies, le site fonctionne normalement mais n'envoie aucun mail.

Ce qui est envoyé :

| Évènement | Élève | Enseignant |
|---|---|---|
| Réservation d'un créneau | confirmation (toujours) | notification (si activée) |
| Annulation par l'enseignant | e-mail d'annulation (toujours) | copie (si activée) |
| Ajout ou suppression d'une plage horaire | rien | récapitulatif des disponibilités (si activé) |

L'enseignant active les notifications dans **Profil > Recevoir des notifications par e-mail**. Elles sont désactivées par défaut.

Limites : Gmail permet environ 500 mails par jour. Une même adresse d'élève ne peut pas faire plus de 5 réservations par jour.

## Tester sur ton ordinateur

`npx wrangler d1 execute cours-db --local --file=schema.sql` (une fois), puis `npx wrangler dev --var MAIL_DEBUG:1` et ouvre http://localhost:8787. Avec `MAIL_DEBUG:1`, les mails s'affichent dans le terminal au lieu d'être envoyés.

## Ce que fait le site

- Les créneaux sont calculés à partir des plages hebdomadaires de chaque enseignant, sur les 21 prochains jours (réglable dans `public/common.js`).
- Le serveur refuse les doublons et les chevauchements, même si deux élèves cliquent en même temps.
- Les coordonnées des élèves ne sont visibles que par l'enseignant concerné.
- Mots de passe stockés sous forme d'empreinte (PBKDF2). Connexion bloquée quelques minutes après 8 échecs.
- Toutes les heures sont celles de Paris.

## Pas encore prévu

- Confirmation de l'adresse e-mail à l'inscription et « mot de passe oublié ».
- Rappel automatique la veille du cours.
- Lien de visio automatique, jours de congé ponctuels, paiement en ligne.
- Validation des nouveaux enseignants : pour l'instant, n'importe qui peut créer un compte enseignant.
