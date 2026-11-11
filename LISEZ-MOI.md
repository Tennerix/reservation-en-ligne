# Réservation de cours particuliers

Deux pages web et une base de données en ligne gratuite (Supabase).

- `index.html` : la page des élèves. Ils choisissent une matière (sport compris), visio ou présentiel, puis un créneau.
- `prof.html` : l'espace des enseignants. Chacun crée un compte, choisit ses matières, entre ses disponibilités de la semaine et voit les réservations.
- `schema.sql` : la structure de la base, à coller une seule fois dans Supabase.
- `config.js` : les deux codes de ton projet Supabase à coller.

## Mise en route (environ 15 minutes)

1. Va sur supabase.com, crée un compte gratuit puis un nouveau projet (choisis une région en Europe).
2. Dans le projet, ouvre **SQL Editor**, clique sur **New query**, colle tout le contenu de `schema.sql` et clique sur **Run**. Tu dois voir « Success ».
3. Ouvre **Project Settings > API**. Copie l'**URL du projet** et la clé **anon public**, puis colle-les dans `config.js` à la place des textes d'exemple.
4. Pour tester vite : **Authentication > Providers > Email**, et désactive « Confirm email ». Les enseignants pourront alors se connecter tout de suite après avoir créé leur compte. Tu pourras la réactiver plus tard.
5. Ouvre `prof.html` (double-clic), crée ton compte, indique ton nom, coche tes matières et ajoute tes plages horaires.
6. Ouvre `index.html` : tes créneaux apparaissent.

## Mettre en ligne

Comme pour BeachStats : crée un dépôt GitHub, envoie-y les fichiers, puis active GitHub Pages dans les réglages du dépôt.

## Ce que fait le site

- Les créneaux sont calculés à partir des plages hebdomadaires de chaque enseignant, sur les 21 prochains jours (réglable dans `config.js`).
- Un créneau pris disparaît pour tout le monde. La base refuse aussi les doublons, même si deux élèves cliquent en même temps.
- Les coordonnées des élèves ne sont visibles que par l'enseignant concerné.
- Toutes les heures sont celles de Paris.

## Pas encore prévu

- Envoi d'emails de confirmation (pour l'instant l'enseignant voit la réservation dans son espace et contacte l'élève).
- Lien de visio automatique.
- Jours de congé ponctuels (en attendant, supprime la plage concernée ou annule les réservations).
- Paiement en ligne.
- Validation des nouveaux enseignants : pour l'instant, n'importe qui peut créer un compte enseignant.
