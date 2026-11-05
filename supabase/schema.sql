-- Apuntes: esquema para Supabase (pegar completo en SQL Editor → Run).
-- Es idempotente: se puede ejecutar más de una vez.

create table if not exists public.notebooks (
  id                text primary key,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title             text not null default '',
  parent_id         text,
  sort_order        integer not null default 0,
  deleted           boolean not null default false,
  created_at        bigint not null,
  updated_at        bigint not null,
  server_updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.notes (
  id                text primary key,
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title             text not null default '',
  html              text not null default '',
  text              text not null default '',
  notebook_ids      text[] not null default '{}',
  tags              text[] not null default '{}',
  pinned            boolean not null default false,
  bookmarked        boolean not null default false,
  trashed           boolean not null default false,
  deleted           boolean not null default false,
  created_at        bigint not null,
  updated_at        bigint not null,
  server_updated_at timestamptz not null default clock_timestamp()
);

create index if not exists notes_user_sync_idx     on public.notes (user_id, server_updated_at);
create index if not exists notebooks_user_sync_idx on public.notebooks (user_id, server_updated_at);

-- Sello de servidor + "gana el cambio más reciente": si llega una versión más vieja
-- que la guardada (otro dispositivo editó después), se conserva la guardada.
create or replace function public.apuntes_before_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      new.user_id := old.user_id;
    end if;
    if new.updated_at < old.updated_at then
      return old;
    end if;
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists notes_before_write on public.notes;
create trigger notes_before_write before insert or update on public.notes
  for each row execute function public.apuntes_before_write();

drop trigger if exists notebooks_before_write on public.notebooks;
create trigger notebooks_before_write before insert or update on public.notebooks
  for each row execute function public.apuntes_before_write();

-- Permisos de la API para usuarios con sesión (Supabase suele darlos por defecto; se dejan explícitos).
grant select, insert, update, delete on public.notes, public.notebooks to authenticated;
revoke all on public.notes, public.notebooks from anon;

-- Seguridad: cada usuario solo ve y modifica lo suyo.
alter table public.notes     enable row level security;
alter table public.notebooks enable row level security;

drop policy if exists notes_owner on public.notes;
create policy notes_owner on public.notes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notebooks_owner on public.notebooks;
create policy notebooks_owner on public.notebooks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Tiempo real (aviso instantáneo de cambios al otro dispositivo).
do $$
begin
  begin alter publication supabase_realtime add table public.notes;     exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.notebooks; exception when duplicate_object then null; end;
end $$;

-- Imágenes y adjuntos: bucket privado; cada usuario usa la carpeta <su id>/...
insert into storage.buckets (id, name, public)
values ('adjuntos', 'adjuntos', false)
on conflict (id) do nothing;

drop policy if exists adjuntos_owner_select on storage.objects;
create policy adjuntos_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists adjuntos_owner_insert on storage.objects;
create policy adjuntos_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists adjuntos_owner_update on storage.objects;
create policy adjuntos_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists adjuntos_owner_delete on storage.objects;
create policy adjuntos_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'adjuntos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Archivos traídos en una migración (por ejemplo desde UpNote). La app los mueve
-- al almacenamiento "adjuntos" la primera vez que inicias sesión y borra la fila.
create table if not exists public.import_files (
  path       text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  mime       text not null default 'application/octet-stream',
  content_b64 text not null,
  created_at timestamptz not null default now()
);
alter table public.import_files enable row level security;
grant select, delete on public.import_files to authenticated;
revoke all on public.import_files from anon;
drop policy if exists import_files_owner on public.import_files;
create policy import_files_owner on public.import_files for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- v1.2: portada de cada libreta ("preset:<clave>" o "file:<ruta>")
alter table public.notebooks add column if not exists cover text;
