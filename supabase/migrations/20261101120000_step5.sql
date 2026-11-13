-- Step 5: invite links. Owners create them; anyone holding a valid token can resolve it to the
-- home's floor plan and published rooms (never to the invites table itself). apps/web then signs
-- a short-lived join ticket for the realtime server, which never reads the database.

-- Invites expire after this long unless the owner revokes them first.
create function public.invite_ttl() returns interval
language sql immutable as $$ select interval '30 days' $$;

-- POST /api/homes/:id/invites
create function public.create_invite(p_home_id uuid)
returns table (token text, expires_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not public.is_home_owner(p_home_id) then
    raise exception 'home not found' using errcode = 'P0002';
  end if;
  -- RLS (invites_owner_insert) re-checks ownership; created_by defaults to auth.uid().
  return query
    insert into public.invites (home_id, expires_at)
    values (p_home_id, now() + public.invite_ttl())
    returning invites.token, invites.expires_at;
end;
$$;

-- The home behind a live invite: id, name, floor plan and the rooms guests can load
-- (published files only). Raises P0002 for unknown, revoked or expired tokens alike, so a
-- caller can't tell them apart. security definer: guests (anon) have no access to the tables.
create function public.resolve_invite(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_home public.homes;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  select h.* into v_home
    from public.invites i
    join public.homes h on h.id = i.home_id
   where i.token = p_token
     and i.revoked_at is null
     and (i.expires_at is null or i.expires_at > now());
  if v_home.id is null then
    raise exception 'invite not found' using errcode = 'P0002';
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
       where r.home_id = v_home.id
         and r.status in ('preview', 'ready')
         and r.splat_url is not null
         and r.collision_url is not null
    )
  );
end;
$$;

revoke execute on function public.create_invite(uuid) from public, anon;
revoke execute on function public.resolve_invite(text) from public;
grant execute on function public.create_invite(uuid) to authenticated;
grant execute on function public.resolve_invite(text) to anon, authenticated;
