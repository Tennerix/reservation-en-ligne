-- =====================================================================
-- Réservation de cours particuliers : base D1 (SQLite) de Cloudflare
-- À exécuter une seule fois :
--   npx wrangler d1 execute cours-db --remote --file=schema.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pass TEXT NOT NULL,                      -- sel$hash (PBKDF2), jamais le mot de passe
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,             -- empreinte SHA-256 du jeton du cookie
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL              -- millisecondes
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Limite les essais de connexion répétés
CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nom TEXT NOT NULL,
  bio TEXT,
  duree_creneau INTEGER NOT NULL DEFAULT 60 CHECK (duree_creneau BETWEEN 15 AND 240),
  notif_email INTEGER NOT NULL DEFAULT 0,   -- 1 = l'enseignant reçoit les e-mails de notification
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matieres (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL UNIQUE,
  categorie TEXT NOT NULL CHECK (categorie IN ('Scolaire','Sport','Autre'))
);

CREATE TABLE IF NOT EXISTS prof_matieres (
  prof_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  matiere_id INTEGER NOT NULL REFERENCES matieres(id) ON DELETE CASCADE,
  tarif REAL,
  PRIMARY KEY (prof_id, matiere_id)
);

-- jour : 0 = dimanche, 1 = lundi ... 6 = samedi (comme en JavaScript)
-- debut / fin : heures de Paris au format HH:MM
CREATE TABLE IF NOT EXISTS disponibilites (
  id TEXT PRIMARY KEY,
  prof_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  jour INTEGER NOT NULL CHECK (jour BETWEEN 0 AND 6),
  debut TEXT NOT NULL,
  fin TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('visio','presentiel','les_deux')),
  lieu TEXT,
  valide_du TEXT,                          -- AAAA-MM-JJ (Paris) ; vide = sans limite
  valide_au TEXT,                          -- dernière date incluse ; vide = sans limite
  CHECK (fin > debut)
);
CREATE INDEX IF NOT EXISTS idx_dispo_prof ON disponibilites(prof_id);

-- debut / fin : instants UTC au format ISO (2026-11-25T16:00:00.000Z)
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  prof_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  matiere_id INTEGER NOT NULL REFERENCES matieres(id),
  debut TEXT NOT NULL,
  fin TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('visio','presentiel')),
  eleve_nom TEXT NOT NULL,
  eleve_email TEXT NOT NULL,
  eleve_tel TEXT,
  message TEXT,
  statut TEXT NOT NULL DEFAULT 'confirme' CHECK (statut IN ('confirme','annule')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_res_prof ON reservations(prof_id, debut);

-- ---------- Matières de départ ----------

INSERT OR IGNORE INTO matieres (nom, categorie) VALUES
  ('Mathématiques','Scolaire'),
  ('Physique-Chimie','Scolaire'),
  ('Sciences de l''ingénieur','Scolaire'),
  ('Français','Scolaire'),
  ('Anglais','Scolaire'),
  ('Informatique','Scolaire'),
  ('Tennis','Sport'),
  ('Beach tennis','Sport'),
  ('Padel','Sport'),
  ('Préparation physique','Sport');
