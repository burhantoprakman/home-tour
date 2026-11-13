-- Step 3: owner app. users (profiles), invites, homes.floor_plan, read/save RPCs for apps/web.
-- Contracts: packages/shared/src/{api,floor-plan,room}.ts. Builds on 20261030120000_step2.sql.

-- ---------------------------------------------------------------------------------------------
-- users: one public profile row per auth.users row (created by trigger on sign-up).
-- ---------------------------------------------------------------------------------------------

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 60),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger users_set_updated_at before update on public.users
  for each row execute function public.set_updated_at();

-- Google sign-ups carry full_name/avatar_url in raw_user_meta_data; magic-link sign-ups don't.
-- Must never fail, or it would block sign-up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name',
                                     new.raw_user_meta_data ->> 'name', '')), 60);
  v_avatar text := new.raw_user_meta_data ->> 'avatar_url';
begin
  insert into public.users (id, display_name, avatar_url)
  values (new.id,
          nullif(v_name, ''),
          case when char_length(v_avatar) <= 2048 then v_avatar end)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users who signed up before this migration.
insert into public.users (id) select id from auth.users on conflict (id) do nothing;

alter table public.users enable row level security;

create policy users_self_select on public.users for select to authenticated
  using (id = (select auth.uid()));
create policy users_self_update on public.users for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

revoke all on public.users from anon, authenticated;
grant select on public.users to authenticated;
grant update (display_name, avatar_url) on public.users to authenticated;
grant all on public.users to service_role;

-- ---------------------------------------------------------------------------------------------
-- homes.floor_plan: the FloorPlan contract as JSON (null until first saved).
-- Written only through save_floor_plan() (security definer: checks ownership, and that every
-- room belongs to the home); owners have no column grant on it.
-- ---------------------------------------------------------------------------------------------

alter table public.homes
  add column floor_plan jsonb
    -- coalesce: a missing key makes jsonb_typeof null, which a CHECK would otherwise pass.
    check (floor_plan is null or coalesce(jsonb_typeof(floor_plan) = 'object'
                                          and jsonb_typeof(floor_plan -> 'rooms') = 'array'
                                          and jsonb_typeof(floor_plan -> 'spawn') = 'object'
                                          and jsonb_typeof(floor_plan -> 'scale') = 'number',
                                          false));

-- ---------------------------------------------------------------------------------------------
-- invites: owner-created links to a home (POST /homes/:id/invites, GET /join/:token in Step 5).
-- Owner-only for every operation; guests will resolve a token through a security definer RPC
-- added in Step 5, never by reading this table.
-- ---------------------------------------------------------------------------------------------

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  -- 64 hex chars (~244 random bits) from two v4 UUIDs; core functions only, no pgcrypto.
  token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    check (token ~ '^[0-9a-f]{64}$'),
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  expires_at timestamptz,  -- null = never expires
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index invites_home_id_idx on public.invites (home_id);

alter table public.invites enable row level security;

create policy invites_owner_select on public.invites for select to authenticated
  using (public.is_home_owner(home_id));
create policy invites_owner_insert on public.invites for insert to authenticated
  with check (public.is_home_owner(home_id) and created_by = (select auth.uid()));
create policy invites_owner_update on public.invites for update to authenticated
  using (public.is_home_owner(home_id)) with check (public.is_home_owner(home_id));
create policy invites_owner_delete on public.invites for delete to authenticated
  using (public.is_home_owner(home_id));

revoke all on public.invites from anon;
grant select, insert, delete on public.invites to authenticated;
grant update (expires_at, revoked_at) on public.invites to authenticated;
grant all on public.invites to service_role;

-- ---------------------------------------------------------------------------------------------
-- Seat confirmations survive the worker's re-publish. Preview and final seats are detected
-- separately and their ids are positional (seat-1, seat-2, ...), so ids can't be matched.
-- When the service role rewrites rooms.seats, each new seat within SEAT_MATCH_M (0.3 m, on x/z)
-- of a seat the owner had confirmed stays confirmed; closest pairs first, each seat used once.
-- ---------------------------------------------------------------------------------------------

-- x/z distance between two Seat JSON objects; null if either position isn't numeric.
create function public.seat_xz_distance(a jsonb, b jsonb) returns double precision
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(a -> 'position' -> 0) = 'number' and jsonb_typeof(a -> 'position' -> 2) = 'number'
     and jsonb_typeof(b -> 'position' -> 0) = 'number' and jsonb_typeof(b -> 'position' -> 2) = 'number'
    then sqrt(power((a -> 'position' ->> 0)::double precision - (b -> 'position' ->> 0)::double precision, 2)
            + power((a -> 'position' ->> 2)::double precision - (b -> 'position' ->> 2)::double precision, 2))
  end;
$$;

create function public.keep_seat_confirmations() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_pair record;
  v_used_new bigint[] := '{}';
  v_used_old bigint[] := '{}';
begin
  if current_user <> 'service_role'
     or jsonb_typeof(old.seats) <> 'array' or jsonb_typeof(new.seats) <> 'array' then
    return new;
  end if;
  for v_pair in
    select n.ord as new_ord, o.ord as old_ord
      from jsonb_array_elements(new.seats) with ordinality as n(s, ord)
      cross join jsonb_array_elements(old.seats) with ordinality as o(s, ord)
     where jsonb_typeof(o.s -> 'confirmed') = 'boolean'
       and (o.s ->> 'confirmed')::boolean
       and public.seat_xz_distance(n.s, o.s) <= 0.3
     order by public.seat_xz_distance(n.s, o.s), n.ord, o.ord
  loop
    continue when v_pair.new_ord = any (v_used_new) or v_pair.old_ord = any (v_used_old);
    v_used_new := v_used_new || v_pair.new_ord;
    v_used_old := v_used_old || v_pair.old_ord;
  end loop;
  if cardinality(v_used_new) = 0 then
    return new;
  end if;
  new.seats := coalesce((
    select jsonb_agg(case when ord = any (v_used_new)
                          then s || '{"confirmed": true}'::jsonb else s end
                     order by ord)
      from jsonb_array_elements(new.seats) with ordinality as e(s, ord)
  ), '[]'::jsonb);
  return new;
end;
$$;

create trigger rooms_keep_seat_confirmations before update of seats on public.rooms
  for each row when (old.seats is distinct from new.seats)
  execute function public.keep_seat_confirmations();

-- ---------------------------------------------------------------------------------------------
-- Column grants. Step 2 granted owners insert/update on every column of homes and rooms, so
-- an owner could PATCH status, splat_url, seats or floor_plan directly through PostgREST.
-- Owners may now only insert a home's name (owner_id defaults to auth.uid(), RLS checks it) and
-- rename homes/rooms. Rooms are created by create_room() and seats/floor plans are written by
-- save_floor_plan(), both security definer; everything else is the worker's (service role).
-- ---------------------------------------------------------------------------------------------

revoke insert, update on public.homes, public.rooms from authenticated;
grant insert (name) on public.homes to authenticated;
grant update (name) on public.homes, public.rooms to authenticated;

-- ---------------------------------------------------------------------------------------------
-- RPCs used by apps/web route handlers, called with the owner's JWT. Reads and create_home are
-- security invoker (RLS decides what the caller sees); save_floor_plan is security definer
-- because owners have no column grant on homes.floor_plan / rooms.seats.
-- Errors: 42501 not signed in, P0002 home not found / not owned, 22023 invalid input.
-- ---------------------------------------------------------------------------------------------

-- POST /api/homes
create function public.create_home(p_name text) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into public.homes (name) values (p_name) returning id into v_id;
  return v_id;
end;
$$;

-- GET /api/homes
create function public.list_homes()
returns table (id uuid, name text, room_count integer)
language sql stable set search_path = '' as $$
  select h.id, h.name,
         (select count(*)::integer from public.rooms r where r.home_id = h.id)
    from public.homes h
   where h.owner_id = (select auth.uid())
   order by h.created_at desc;
$$;

-- Newest job per room of a home (RoomProgress in packages/shared/src/api.ts, plus the video
-- path so the web app can rebuild the upload target until the job is enqueued).
create function public.home_progress(p_home_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'roomId', r.id,
           'status', r.status,
           'stage', coalesce(j.stage, 'queued'),
           'progress', coalesce(j.progress, 0),
           'error', j.error,
           'videoPath', j.video_path,
           'enqueued', j.enqueued_at is not null
         ) order by r.created_at), '[]'::jsonb)
    from public.rooms r
    left join lateral (
      select jj.stage, jj.progress, jj.error, jj.video_path, jj.enqueued_at
        from public.jobs jj
       where jj.room_id = r.id
       order by jj.created_at desc
       limit 1
    ) j on true
   where r.home_id = p_home_id;
$$;

-- GET /api/homes/:id/status (polled by the SSE stream)
create function public.home_status(p_home_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (select 1 from public.homes h where h.id = p_home_id) then
    raise exception 'home not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('rooms', public.home_progress(p_home_id));
end;
$$;

-- GET /api/homes/:id: the home, its rooms (Room contract), progress and floor plan.
create function public.get_home(p_home_id uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_home public.homes;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_home from public.homes h where h.id = p_home_id;
  if v_home.id is null then
    raise exception 'home not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'id', v_home.id,
    'name', v_home.name,
    'floorPlan', v_home.floor_plan,
    'rooms', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id,
               'homeId', r.home_id,
               'name', r.name,
               'status', r.status,
               'splatUrl', r.splat_url,
               'collisionUrl', r.collision_url,
               'seats', r.seats,
               'transform', r.transform
             ) order by r.created_at), '[]'::jsonb)
        from public.rooms r
       where r.home_id = p_home_id
    ),
    'progress', public.home_progress(p_home_id)
  );
end;
$$;

-- PUT /api/homes/:id/floor-plan: save the plan and seat confirmations in one transaction.
-- p_plan is a validated FloorPlan; p_seats is [{roomId, confirmedSeatIds: string[]}].
create function public.save_floor_plan(p_home_id uuid, p_plan jsonb, p_seats jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_entry jsonb;
  v_ids text[];
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not public.is_home_owner(p_home_id) then
    raise exception 'home not found' using errcode = 'P0002';
  end if;
  -- "is distinct from" so a null plan or a missing key is rejected, not let through as null.
  if jsonb_typeof(p_plan) is distinct from 'object'
     or jsonb_typeof(p_plan -> 'rooms') is distinct from 'array'
     or jsonb_typeof(p_plan -> 'spawn') is distinct from 'object'
     or jsonb_typeof(p_plan -> 'scale') is distinct from 'number'
     or jsonb_typeof(p_seats) is distinct from 'array' then
    raise exception 'invalid floor plan' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_plan -> 'rooms') pr
     where not exists (
       select 1 from public.rooms r
        where r.home_id = p_home_id and r.id::text = pr ->> 'roomId'
     )
  ) then
    raise exception 'floor plan names a room outside this home' using errcode = '22023';
  end if;

  update public.homes set floor_plan = p_plan where id = p_home_id;

  for v_entry in select * from jsonb_array_elements(p_seats) loop
    select coalesce(array_agg(x), '{}') into v_ids
      from jsonb_array_elements_text(v_entry -> 'confirmedSeatIds') x;
    update public.rooms r
       set seats = coalesce((
             select jsonb_agg(s || jsonb_build_object('confirmed', (s ->> 'id') = any (v_ids))
                              order by ord)
               from jsonb_array_elements(r.seats) with ordinality as e(s, ord)
           ), '[]'::jsonb)
     where r.home_id = p_home_id and r.id::text = v_entry ->> 'roomId';
    if not found then
      raise exception 'seat update names a room outside this home' using errcode = '22023';
    end if;
  end loop;
end;
$$;

revoke execute on function public.create_home(text) from public, anon;
revoke execute on function public.list_homes() from public, anon;
revoke execute on function public.home_progress(uuid) from public, anon;
revoke execute on function public.home_status(uuid) from public, anon;
revoke execute on function public.get_home(uuid) from public, anon;
revoke execute on function public.save_floor_plan(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.seat_xz_distance(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.seat_xz_distance(jsonb, jsonb) to service_role;
grant execute on function public.create_home(text) to authenticated;
grant execute on function public.list_homes() to authenticated;
grant execute on function public.home_progress(uuid) to authenticated;
grant execute on function public.home_status(uuid) to authenticated;
grant execute on function public.get_home(uuid) to authenticated;
grant execute on function public.save_floor_plan(uuid, jsonb, jsonb) to authenticated;
