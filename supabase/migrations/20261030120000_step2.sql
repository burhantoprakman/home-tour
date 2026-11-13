-- Step 2: homes, rooms, jobs, storage buckets, RLS.
-- Contracts: packages/shared/src/{room,job,api}.ts; worker/pipeline/{store,job}.py.
-- The worker uses the service role (bypasses RLS) and PATCHes:
--   jobs  {status, stage, progress, error, gpu_seconds, stage_timings}
--   rooms {status, splat_url, collision_url, seats}

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.homes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);
create index homes_owner_id_idx on public.homes (owner_id);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  status text not null default 'queued'
    check (status in ('queued', 'solving', 'training', 'preview', 'ready', 'failed')),
  splat_url text,
  collision_url text,
  seats jsonb not null default '[]'::jsonb check (jsonb_typeof(seats) = 'array'),
  transform jsonb not null default '{"position": [0, 0, 0], "rotationYaw": 0, "scale": 1}'::jsonb
    check (jsonb_typeof(transform) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rooms_home_id_idx on public.rooms (home_id);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'solving', 'training', 'preview', 'ready', 'failed')),
  stage text not null default 'queued'
    check (stage in ('queued', 'download', 'frames', 'solve', 'floor', 'train',
                     'publish_preview', 'publish_final', 'done')),
  progress real not null default 0 check (progress >= 0 and progress <= 1),
  error text,
  gpu_seconds real not null default 0 check (gpu_seconds >= 0),
  stage_timings jsonb not null default '{}'::jsonb check (jsonb_typeof(stage_timings) = 'object'),
  -- Web-app bookkeeping (the worker never writes these):
  video_path text not null,          -- object path in the room-videos bucket
  enqueued_at timestamptz,           -- set once the Modal job has been spawned
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_room_id_created_at_idx on public.jobs (room_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger rooms_set_updated_at before update on public.rooms
  for each row execute function public.set_updated_at();
create trigger jobs_set_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();

-- The worker only writes rooms.status for preview/ready/failed; mirror the job status so the
-- room also shows solving/training. Never move a room back from preview/ready to an earlier state.
create function public.sync_room_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.rooms r
     set status = new.status
   where r.id = new.room_id
     and r.status is distinct from new.status
     and not (r.status in ('preview', 'ready') and new.status in ('queued', 'solving', 'training'));
  return new;
end;
$$;

create trigger jobs_sync_room_status after update of status on public.jobs
  for each row when (old.status is distinct from new.status)
  execute function public.sync_room_status();

-- ---------------------------------------------------------------------------------------------
-- Ownership helpers (security definer: no RLS recursion, cheap in policies)
-- ---------------------------------------------------------------------------------------------

create function public.is_home_owner(p_home_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.homes h where h.id = p_home_id and h.owner_id = (select auth.uid())
  );
$$;

create function public.is_room_owner(p_room_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.rooms r
      join public.homes h on h.id = r.home_id
     where r.id = p_room_id and h.owner_id = (select auth.uid())
  );
$$;

-- True for `rooms/<roomId>/video.<mp4|mov|webm>` when the caller owns that room
-- (roomVideoPath in packages/shared/src/api.ts).
create function public.owns_room_video_path(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  parts text[] := string_to_array(p_name, '/');
begin
  if coalesce(array_length(parts, 1), 0) <> 3
     or parts[1] <> 'rooms'
     or parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or parts[3] !~ '^video\.(mp4|mov|webm)$' then
    return false;
  end if;
  return public.is_room_owner(parts[2]::uuid);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security. Owners read/write their homes and rooms; jobs are read-only for owners
-- (status, progress and GPU cost come from the worker) and are created/claimed only through the
-- RPCs below. The service role (worker) bypasses RLS.
-- ---------------------------------------------------------------------------------------------

alter table public.homes enable row level security;
alter table public.rooms enable row level security;
alter table public.jobs enable row level security;

create policy homes_owner_select on public.homes for select to authenticated
  using (owner_id = (select auth.uid()));
create policy homes_owner_insert on public.homes for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy homes_owner_update on public.homes for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy homes_owner_delete on public.homes for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy rooms_owner_select on public.rooms for select to authenticated
  using (public.is_home_owner(home_id));
create policy rooms_owner_insert on public.rooms for insert to authenticated
  with check (public.is_home_owner(home_id));
create policy rooms_owner_update on public.rooms for update to authenticated
  using (public.is_home_owner(home_id)) with check (public.is_home_owner(home_id));
create policy rooms_owner_delete on public.rooms for delete to authenticated
  using (public.is_home_owner(home_id));

create policy jobs_owner_select on public.jobs for select to authenticated
  using (public.is_room_owner(room_id));

revoke all on public.homes, public.rooms, public.jobs from anon;
grant select, insert, update, delete on public.homes, public.rooms to authenticated;
revoke insert, update, delete on public.jobs from authenticated;
grant select on public.jobs to authenticated;
grant all on public.homes, public.rooms, public.jobs to service_role;

-- ---------------------------------------------------------------------------------------------
-- RPCs used by apps/web route handlers (called with the owner's JWT, never the service key)
-- ---------------------------------------------------------------------------------------------

-- POST /api/homes/:id/rooms: room (queued) + its job in one transaction.
-- Errors: 42501 not signed in, P0002 home not found / not owned, 22023 bad extension.
create function public.create_room(p_home_id uuid, p_name text, p_video_ext text)
returns table (room_id uuid, job_id uuid, video_path text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_room uuid;
  v_job uuid;
  v_path text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not public.is_home_owner(p_home_id) then
    raise exception 'home not found' using errcode = 'P0002';
  end if;
  if p_video_ext is null or p_video_ext not in ('mp4', 'mov', 'webm') then
    raise exception 'unsupported video type' using errcode = '22023';
  end if;
  insert into public.rooms (home_id, name) values (p_home_id, p_name) returning id into v_room;
  v_path := 'rooms/' || v_room::text || '/video.' || p_video_ext;
  insert into public.jobs (room_id, video_path) values (v_room, v_path) returning id into v_job;
  return query select v_room, v_job, v_path;
end;
$$;

-- POST /api/rooms/:id/uploaded: claim the room's newest job for enqueueing (exactly once).
-- Errors: 42501 not signed in, P0002 room not found / not owned,
--         55000 video not uploaded yet, or job already enqueued.
create function public.claim_room_upload(p_room_id uuid)
returns table (job_id uuid, room_id uuid, video_path text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_job uuid;
  v_path text;
  v_enqueued timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not public.is_room_owner(p_room_id) then
    raise exception 'room not found' using errcode = 'P0002';
  end if;
  select j.id, j.video_path, j.enqueued_at into v_job, v_path, v_enqueued
    from public.jobs j
   where j.room_id = p_room_id
   order by j.created_at desc
   limit 1
     for update;
  if v_job is null then
    raise exception 'room not found' using errcode = 'P0002';
  end if;
  if v_enqueued is not null then
    raise exception 'job already enqueued' using errcode = '55000';
  end if;
  if not exists (
    select 1 from storage.objects o where o.bucket_id = 'room-videos' and o.name = v_path
  ) then
    raise exception 'video not uploaded' using errcode = '55000';
  end if;
  update public.jobs set enqueued_at = now() where id = v_job;
  return query select v_job, p_room_id, v_path;
end;
$$;

-- Undo a claim when spawning the Modal job failed, so the owner can retry.
create function public.release_room_upload(p_job_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs j
     set enqueued_at = null
   where j.id = p_job_id
     and j.status = 'queued'
     and j.stage = 'queued'
     and public.is_room_owner(j.room_id);
end;
$$;

revoke execute on function public.create_room(uuid, text, text) from public, anon;
revoke execute on function public.claim_room_upload(uuid) from public, anon;
revoke execute on function public.release_room_upload(uuid) from public, anon;
grant execute on function public.create_room(uuid, text, text) to authenticated;
grant execute on function public.claim_room_upload(uuid) to authenticated;
grant execute on function public.release_room_upload(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Storage (STORAGE_BUCKETS in packages/shared/src/job.ts)
-- ---------------------------------------------------------------------------------------------

-- room-videos: private; owners upload (TUS) to rooms/<roomId>/video.<ext> of their own rooms.
-- The effective size limit is also capped by the project's global upload limit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('room-videos', 'room-videos', false, 2147483648,
        array['video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do nothing;

-- room-files: public read (viewer/CDN); only the worker (service role) writes.
insert into storage.buckets (id, name, public)
values ('room-files', 'room-files', true)
on conflict (id) do nothing;

create policy room_videos_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'room-videos' and public.owns_room_video_path(name));
-- select + update are needed for re-uploads (x-upsert) of the same room video.
create policy room_videos_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'room-videos' and public.owns_room_video_path(name));
create policy room_videos_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'room-videos' and public.owns_room_video_path(name))
  with check (bucket_id = 'room-videos' and public.owns_room_video_path(name));
