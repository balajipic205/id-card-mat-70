-- =====================================================================
-- Make-A-Thon 7.0 — Attendance & Sessions setup
-- Run this ENTIRE file once in your Supabase SQL Editor.
-- Safe to re-run: every statement is idempotent.
-- =====================================================================

-- 1. ROLES ------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('admin', 'volunteer', 'user');
exception when duplicate_object then null; end $$;

create table if not exists public.user_roles (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

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

drop policy if exists "user can read own roles"           on public.user_roles;
drop policy if exists "admins manage all roles"           on public.user_roles;
create policy "user can read own roles"
  on public.user_roles for select
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'));
create policy "admins manage all roles"
  on public.user_roles for all
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));


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
  member_id          uuid,
  team_id            uuid,
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

-- Volunteers and admins can insert NEW rows (lock will be true by default).
create policy "staff inserts attendance"
  on public.attendance for insert
  with check (
    public.has_role(auth.uid(), 'admin') or
    public.has_role(auth.uid(), 'volunteer')
  );

-- Only admins can update (i.e. unlock / re-sign) or delete.
create policy "admin updates attendance"
  on public.attendance for update
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

create policy "admin deletes attendance"
  on public.attendance for delete
  using (public.has_role(auth.uid(), 'admin'));


-- 4. SIGNATURE STORAGE BUCKET ----------------------------------------
insert into storage.buckets (id, name, public)
values ('signatures', 'signatures', false)
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


-- 5. GRANT YOURSELF ADMIN ---------------------------------------------
-- Replace YOUR_AUTH_USER_ID with your uid from Authentication > Users.
-- insert into public.user_roles (user_id, role)
-- values ('YOUR_AUTH_USER_ID', 'admin')
-- on conflict do nothing;
