-- =====================================================================
-- Réservation de cours particuliers : structure de la base (Supabase)
-- À coller en entier dans Supabase > SQL Editor > Run
-- =====================================================================

create extension if not exists btree_gist;

-- ---------- Tables ----------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nom text not null,
  bio text,
  duree_creneau int not null default 60 check (duree_creneau between 15 and 240),
  created_at timestamptz not null default now()
);

create table public.matieres (
  id serial primary key,
  nom text not null unique,
  categorie text not null check (categorie in ('Scolaire','Sport','Autre'))
);

create table public.prof_matieres (
  prof_id uuid not null references public.profiles(id) on delete cascade,
  matiere_id int not null references public.matieres(id) on delete cascade,
  tarif numeric(6,2),
  primary key (prof_id, matiere_id)
);

-- jour : 0 = dimanche, 1 = lundi ... 6 = samedi (comme en JavaScript)
create table public.disponibilites (
  id uuid primary key default gen_random_uuid(),
  prof_id uuid not null references public.profiles(id) on delete cascade,
  jour smallint not null check (jour between 0 and 6),
  debut time not null,
  fin time not null,
  mode text not null check (mode in ('visio','presentiel','les_deux')),
  lieu text,
  check (fin > debut)
);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  prof_id uuid not null references public.profiles(id) on delete cascade,
  matiere_id int not null references public.matieres(id),
  debut timestamptz not null,
  fin timestamptz not null,
  mode text not null check (mode in ('visio','presentiel')),
  eleve_nom text not null,
  eleve_email text not null,
  eleve_tel text,
  message text,
  statut text not null default 'confirme' check (statut in ('confirme','annule')),
  created_at timestamptz not null default now(),
  -- impossible de réserver deux fois le même créneau chez un même enseignant
  constraint pas_de_chevauchement
    exclude using gist (prof_id with =, tstzrange(debut, fin) with &&)
    where (statut = 'confirme')
);

create index on public.disponibilites (prof_id);
create index on public.reservations (prof_id, debut);

-- ---------- Sécurité (Row Level Security) ----------

alter table public.profiles enable row level security;
alter table public.matieres enable row level security;
alter table public.prof_matieres enable row level security;
alter table public.disponibilites enable row level security;
alter table public.reservations enable row level security;

-- Tout le monde peut lire les profils, matières et disponibilités
create policy "lecture profils" on public.profiles for select using (true);
create policy "lecture matieres" on public.matieres for select using (true);
create policy "lecture prof_matieres" on public.prof_matieres for select using (true);
create policy "lecture disponibilites" on public.disponibilites for select using (true);

-- Un enseignant gère uniquement ses propres données
create policy "creer son profil" on public.profiles for insert with check (auth.uid() = id);
create policy "modifier son profil" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "ajouter une matiere" on public.matieres for insert with check (auth.uid() is not null);

create policy "ses matieres insert" on public.prof_matieres for insert with check (auth.uid() = prof_id);
create policy "ses matieres update" on public.prof_matieres for update using (auth.uid() = prof_id) with check (auth.uid() = prof_id);
create policy "ses matieres delete" on public.prof_matieres for delete using (auth.uid() = prof_id);

create policy "ses dispos insert" on public.disponibilites for insert with check (auth.uid() = prof_id);
create policy "ses dispos update" on public.disponibilites for update using (auth.uid() = prof_id) with check (auth.uid() = prof_id);
create policy "ses dispos delete" on public.disponibilites for delete using (auth.uid() = prof_id);

-- Les réservations (qui contiennent les coordonnées des élèves) ne sont lisibles
-- que par l'enseignant concerné. Les élèves passent par la fonction reserver() ci-dessous.
create policy "voir ses reservations" on public.reservations for select using (auth.uid() = prof_id);
create policy "modifier ses reservations" on public.reservations for update using (auth.uid() = prof_id) with check (auth.uid() = prof_id);

-- ---------- Fonctions appelées par le site ----------

-- Liste des créneaux déjà pris (sans aucune info personnelle)
create or replace function public.creneaux_pris(p_from timestamptz, p_to timestamptz)
returns table(prof_id uuid, debut timestamptz, fin timestamptz)
language sql stable security definer set search_path = public as $$
  select r.prof_id, r.debut, r.fin
  from public.reservations r
  where r.statut = 'confirme' and r.debut < p_to and r.fin > p_from;
$$;

-- Réservation d'un créneau : tout est revérifié côté serveur
create or replace function public.reserver(
  p_prof uuid, p_matiere int, p_debut timestamptz, p_mode text,
  p_nom text, p_email text, p_tel text default null, p_message text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_duree int;
  v_fin timestamptz;
  v_loc timestamp;
  v_loc_fin timestamp;
  v_id uuid;
begin
  if p_mode not in ('visio','presentiel') then
    raise exception 'Mode invalide';
  end if;
  if length(trim(coalesce(p_nom,''))) < 2 or length(p_nom) > 80
     or coalesce(p_email,'') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(p_email) > 120 then
    raise exception 'Nom ou email invalide';
  end if;
  if p_debut < now() + interval '2 hours' or p_debut > now() + interval '90 days' then
    raise exception 'Ce créneau n''est plus disponible';
  end if;

  select duree_creneau into v_duree from public.profiles where id = p_prof;
  if v_duree is null then
    raise exception 'Enseignant introuvable';
  end if;
  if not exists (select 1 from public.prof_matieres where prof_id = p_prof and matiere_id = p_matiere) then
    raise exception 'Matière non proposée par cet enseignant';
  end if;

  v_fin := p_debut + make_interval(mins => v_duree);
  v_loc := p_debut at time zone 'Europe/Paris';
  v_loc_fin := v_fin at time zone 'Europe/Paris';

  if not exists (
    select 1 from public.disponibilites d
    where d.prof_id = p_prof
      and d.jour = extract(dow from v_loc)::int
      and d.debut <= v_loc::time
      and d.fin >= v_loc_fin::time
      and v_loc::date = v_loc_fin::date
      and (d.mode = p_mode or d.mode = 'les_deux')
  ) then
    raise exception 'Ce créneau n''est pas proposé';
  end if;

  begin
    insert into public.reservations (prof_id, matiere_id, debut, fin, mode, eleve_nom, eleve_email, eleve_tel, message)
    values (p_prof, p_matiere, p_debut, v_fin, p_mode, trim(p_nom), trim(p_email),
            nullif(trim(coalesce(p_tel,'')), ''), nullif(trim(coalesce(p_message,'')), ''))
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'Ce créneau vient d''être pris';
  end;

  return v_id;
end;
$$;

revoke all on function public.creneaux_pris(timestamptz, timestamptz) from public;
revoke all on function public.reserver(uuid, int, timestamptz, text, text, text, text, text) from public;
grant execute on function public.creneaux_pris(timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.reserver(uuid, int, timestamptz, text, text, text, text, text) to anon, authenticated;

-- ---------- Matières de départ ----------

insert into public.matieres (nom, categorie) values
  ('Mathématiques','Scolaire'),
  ('Physique-Chimie','Scolaire'),
  ('Sciences de l''ingénieur','Scolaire'),
  ('Français','Scolaire'),
  ('Anglais','Scolaire'),
  ('Informatique','Scolaire'),
  ('Tennis','Sport'),
  ('Beach tennis','Sport'),
  ('Padel','Sport'),
  ('Préparation physique','Sport')
on conflict (nom) do nothing;
