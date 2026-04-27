-- =====================================================================
-- Make-A-Thon 7.0 — Attendance & Sessions setup
-- Compatible with Make-a-Thon 7.0 Database Schema
-- Run this ENTIRE file once in your Supabase SQL Editor.
-- Safe to re-run: every statement is idempotent.
-- =====================================================================

-- 1. ROLES & ENUM UPDATE ----------------------------------------------
-- IMPORTANT: Postgres requires adding enum values in a separate transaction!
-- STEP 1: Highlight ONLY the line below, and click "Run" in Supabase:
--   ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'volunteer';
-- STEP 2: After that runs successfully, run the REST of this file.

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  );
$$;

-- 2. ATTENDANCE SESSIONS ---------------------------------------------
create table if not exists public.attendance_sessions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  notes       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists attendance_sessions_starts_idx
  on public.attendance_sessions (starts_at desc);

alter table public.attendance_sessions enable row level security;

drop policy if exists "session readable to staff"  on public.attendance_sessions;
drop policy if exists "admin manages sessions"     on public.attendance_sessions;

create policy "session readable to staff"
  on public.attendance_sessions for select
  using (
    public.has_role(auth.uid(), 'admin') or
    public.has_role(auth.uid(), 'volunteer')
  );

create policy "admin manages sessions"
  on public.attendance_sessions for all
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- 3. ATTENDANCE -------------------------------------------------------
create table if not exists public.attendance (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references public.attendance_sessions(id) on delete cascade,
  unique_member_id   text not null,
  member_id          uuid references public.members(id) on delete set null,
  team_id            uuid references public.teams(id) on delete set null,
  full_name          text,
  team_name          text,
  checked            boolean not null default true,
  signature_path     text,
  signature_url      text,
  marked_by          uuid references auth.users(id) on delete set null,
  marked_at          timestamptz not null default now(),
  locked             boolean not null default true,
  unlocked_by        uuid references auth.users(id) on delete set null,
  unlocked_at        timestamptz,
  unique (session_id, unique_member_id)
);

create index if not exists attendance_session_idx on public.attendance(session_id);
create index if not exists attendance_uid_idx     on public.attendance(unique_member_id);

alter table public.attendance enable row level security;

drop policy if exists "staff reads attendance"      on public.attendance;
drop policy if exists "staff inserts attendance"    on public.attendance;
drop policy if exists "admin updates attendance"    on public.attendance;
drop policy if exists "admin deletes attendance"    on public.attendance;

create policy "staff reads attendance"
  on public.attendance for select
  using (
    public.has_role(auth.uid(), 'admin') or
    public.has_role(auth.uid(), 'volunteer')
  );

-- Volunteers and admins can insert NEW rows
create policy "staff inserts attendance"
  on public.attendance for insert
  with check (
    public.has_role(auth.uid(), 'admin') or
    public.has_role(auth.uid(), 'volunteer')
  );

create policy "admin updates attendance"
  on public.attendance for update
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

create policy "admin deletes attendance"
  on public.attendance for delete
  using (public.has_role(auth.uid(), 'admin'));

-- 3b. SESSION WINDOW ENFORCEMENT (DB-level guard) --------------------
-- Even if the UI is bypassed, attendance can ONLY be inserted while the
-- chosen session window is currently active.
create or replace function public.enforce_session_window()
returns trigger
language plpgsql
as $$
declare
  s_start timestamptz;
  s_end   timestamptz;
begin
  select starts_at, ends_at into s_start, s_end
  from public.attendance_sessions where id = NEW.session_id;
  if s_start is null then
    raise exception 'Session not found';
  end if;
  if now() < s_start then
    raise exception 'Session has not started yet (starts at %)', s_start
      using errcode = 'P0001';
  end if;
  if now() > s_end then
    raise exception 'Session has already ended (ended at %)', s_end
      using errcode = 'P0001';
  end if;
  return NEW;
end;
$$;

drop trigger if exists attendance_session_window on public.attendance;
create trigger attendance_session_window
  before insert on public.attendance
  for each row execute function public.enforce_session_window();

-- 3c. BLOCKED / OUT-OF-WINDOW SCAN AUDIT LOG --------------------------
create table if not exists public.attendance_attempts (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid references public.attendance_sessions(id) on delete set null,
  unique_member_id   text,
  reason             text not null, -- 'before_window' | 'after_window' | 'duplicate' | 'no_session' | 'unknown_member'
  attempted_by       uuid references auth.users(id) on delete set null,
  attempted_at       timestamptz not null default now(),
  details            jsonb
);

create index if not exists attendance_attempts_session_idx
  on public.attendance_attempts(session_id);

alter table public.attendance_attempts enable row level security;

drop policy if exists "staff inserts attempts" on public.attendance_attempts;
drop policy if exists "staff reads attempts"   on public.attendance_attempts;

create policy "staff inserts attempts"
  on public.attendance_attempts for insert
  with check (
    public.has_role(auth.uid(), 'admin') or
    public.has_role(auth.uid(), 'volunteer')
  );

create policy "staff reads attempts"
  on public.attendance_attempts for select
  using (
    public.has_role(auth.uid(), 'admin') or
    public.has_role(auth.uid(), 'volunteer')
  );

-- 4. SIGNATURE STORAGE BUCKET ----------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signatures', 'signatures', false, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "staff reads signatures"   on storage.objects;
drop policy if exists "staff uploads signatures" on storage.objects;
drop policy if exists "admin manages signatures" on storage.objects;

create policy "staff reads signatures"
  on storage.objects for select
  using (
    bucket_id = 'signatures'
    and (
      public.has_role(auth.uid(), 'admin') or
      public.has_role(auth.uid(), 'volunteer')
    )
  );

create policy "staff uploads signatures"
  on storage.objects for insert
  with check (
    bucket_id = 'signatures'
    and (
      public.has_role(auth.uid(), 'admin') or
      public.has_role(auth.uid(), 'volunteer')
    )
  );

create policy "admin manages signatures"
  on storage.objects for all
  using (
    bucket_id = 'signatures'
    and public.has_role(auth.uid(), 'admin')
  )
  with check (
    bucket_id = 'signatures'
    and public.has_role(auth.uid(), 'admin')
  );
