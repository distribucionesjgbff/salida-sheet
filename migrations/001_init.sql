begin;

create table public.items (
  id text primary key,
  title text not null default '',
  available_quantity integer not null default 0 check (available_quantity >= 0),
  has_variations boolean not null default false,
  variations_raw jsonb not null default '[]' check (jsonb_typeof(variations_raw) = 'array'),
  last_synced_at timestamptz,
  last_ml_update_at timestamptz,
  sync_status text not null default 'pending' check (sync_status in ('ok','error','pending')),
  last_error text,
  updated_at timestamptz not null default now(),
  -- El snapshot remoto y la intención local deben poder coexistir.
  stock_by_variation jsonb check (stock_by_variation is null or jsonb_typeof(stock_by_variation) = 'object'),
  stock_revision bigint not null default 0,
  push_pending boolean not null default false
);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  mode text not null check (mode in ('full_import','refresh_selected','incremental')),
  items_processed integer not null default 0 check (items_processed >= 0),
  items_failed integer not null default 0 check (items_failed >= 0),
  status text not null default 'running' check (status in ('running','completed','failed')),
  notes text,
  -- Mantiene los modos solicitados; el espejo usa mode=incremental/task=mirror.
  task text not null default 'sync' check (task in ('sync','mirror'))
);

create table public.ml_auth (
  id integer primary key default 1 check (id = 1),
  refresh_token text,
  access_token text,
  expires_at timestamptz,
  seller_id bigint,
  refresh_in_progress boolean not null default false,
  updated_at timestamptz not null default now(),
  -- Leases independientes para sync y espejo; una sola fila de credenciales.
  locks jsonb not null default '{}'
);
insert into public.ml_auth(id) values (1);

alter table public.items enable row level security;
alter table public.sync_runs enable row level security;
alter table public.ml_auth enable row level security;
revoke all on public.items, public.sync_runs, public.ml_auth from anon, authenticated;
grant all on public.items, public.sync_runs, public.ml_auth to service_role;
create index items_pending_idx on public.items(id) where push_pending;
create index sync_runs_started_idx on public.sync_runs(started_at desc);

create function public.items_before_update() returns trigger
language plpgsql set search_path = '' as $$
declare v_total bigint; v_value jsonb;
begin
  new.updated_at := clock_timestamp();
  if coalesce(current_setting('stock_sync.internal', true), '') = 'on' then return new; end if;
  if new.variations_raw is distinct from old.variations_raw then
    raise exception 'variations_raw es un snapshot de ML; editar stock_by_variation';
  end if;
  if new.stock_by_variation is distinct from old.stock_by_variation
     or new.available_quantity is distinct from old.available_quantity then
    if new.stock_by_variation is distinct from old.stock_by_variation and new.stock_by_variation is not null then
      if not new.has_variations then raise exception 'El item no tiene variaciones'; end if;
      v_total := 0;
      for v_value in select value from jsonb_each(new.stock_by_variation) loop
        if jsonb_typeof(v_value) <> 'number' or v_value::text !~ '^[0-9]+$' then
          raise exception 'Stock por variacion debe ser entero no negativo';
        end if;
        v_total := v_total + (v_value::text)::bigint;
      end loop;
      new.available_quantity := v_total;
    end if;
    new.stock_revision := old.stock_revision + 1;
    new.push_pending := true;
    new.sync_status := 'pending';
    new.last_error := null;
  end if;
  return new;
end $$;
create trigger items_updated before update on public.items
for each row execute function public.items_before_update();

-- Todas las RPC se ejecutan solo con service_role. Un lease vencido no puede
-- confirmar resultados ni persistir tokens. La renovación dura cinco minutos.
create function public.job_lock(p_task text, p_owner uuid, p_action text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_locks jsonb; v_lock jsonb;
begin
  if p_task not in ('sync','mirror') then raise exception 'Invalid task'; end if;
  select locks into v_locks from public.ml_auth where id = 1 for update;
  v_lock := v_locks -> p_task;
  if p_action = 'acquire' then
    if (v_lock->>'until')::timestamptz > clock_timestamp() then return false; end if;
  elsif p_action in ('renew','release') then
    if v_lock->>'owner' is distinct from p_owner::text
       or (v_lock->>'until')::timestamptz <= clock_timestamp() then return false; end if;
  else raise exception 'Invalid action'; end if;
  if p_action = 'release' then
    update public.ml_auth set locks = locks - p_task where id = 1;
  else
    update public.ml_auth set locks = jsonb_set(locks, array[p_task],
      jsonb_build_object('owner', p_owner, 'until', clock_timestamp() + interval '5 minutes')) where id = 1;
  end if;
  return true;
end $$;

create function public.assert_sync_lock(p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_lock jsonb;
begin
  select locks->'sync' into v_lock from public.ml_auth where id = 1 for update;
  if v_lock->>'owner' is distinct from p_owner::text
     or coalesce((v_lock->>'until')::timestamptz, '-infinity') <= clock_timestamp() then
    raise exception 'Sync lease lost';
  end if;
end $$;

create function public.save_ml_auth(p_owner uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_sync_lock(p_owner);
  update public.ml_auth set
    refresh_token = coalesce(p_data->>'refresh_token', refresh_token),
    access_token = case when p_data ? 'access_token' then p_data->>'access_token' else access_token end,
    expires_at = case when p_data ? 'expires_at' then (p_data->>'expires_at')::timestamptz else expires_at end,
    seller_id = coalesce((p_data->>'seller_id')::bigint, seller_id),
    refresh_in_progress = coalesce((p_data->>'refresh_in_progress')::boolean, refresh_in_progress),
    updated_at = clock_timestamp()
  where id = 1;
end $$;

create function public.apply_ml_snapshot(p_owner uuid, p_item jsonb, p_revision bigint default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_old public.items; v_variations jsonb; v_qty integer; v_desired jsonb;
begin
  perform public.assert_sync_lock(p_owner);
  perform set_config('stock_sync.internal', 'on', true);
  select * into v_old from public.items where id = p_item->>'id' for update;
  -- Import/refresh nunca pisa intención local. Confirmación de PUT usa CAS.
  if found and (v_old.push_pending and p_revision is null
      or p_revision is not null and v_old.stock_revision <> p_revision) then return false; end if;
  v_variations := coalesce(p_item->'variations', '[]');
  if jsonb_array_length(v_variations) > 0 then
    select coalesce(sum((v->>'available_quantity')::integer),0),
      jsonb_object_agg(v->>'id', v->'available_quantity') into v_qty, v_desired
      from jsonb_array_elements(v_variations) v;
  else
    v_qty := (p_item->>'available_quantity')::integer;
    v_desired := null;
  end if;
  insert into public.items(id,title,available_quantity,has_variations,variations_raw,
    last_synced_at,last_ml_update_at,sync_status,last_error,stock_by_variation,push_pending)
  values(p_item->>'id',p_item->>'title',v_qty,jsonb_array_length(v_variations)>0,v_variations,
    clock_timestamp(),(p_item->>'last_updated')::timestamptz,'ok',null,v_desired,false)
  on conflict(id) do update set title=excluded.title,available_quantity=excluded.available_quantity,
    has_variations=excluded.has_variations,variations_raw=excluded.variations_raw,
    last_synced_at=excluded.last_synced_at,last_ml_update_at=excluded.last_ml_update_at,
    sync_status='ok',last_error=null,stock_by_variation=excluded.stock_by_variation,push_pending=false;
  return true;
end $$;

create function public.mark_item_error(p_owner uuid, p_id text, p_error text, p_revision bigint default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_sync_lock(p_owner);
  insert into public.items(id,sync_status,last_error) values(p_id,'error',left(p_error,2000))
  on conflict(id) do update set sync_status='error',last_error=excluded.last_error
    where (p_revision is null and not public.items.push_pending)
       or public.items.stock_revision = p_revision;
end $$;

revoke execute on function public.items_before_update() from public, anon, authenticated;
revoke execute on function public.job_lock(text,uuid,text) from public, anon, authenticated;
revoke execute on function public.assert_sync_lock(uuid) from public, anon, authenticated;
revoke execute on function public.save_ml_auth(uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.apply_ml_snapshot(uuid,jsonb,bigint) from public, anon, authenticated;
revoke execute on function public.mark_item_error(uuid,text,text,bigint) from public, anon, authenticated;
grant execute on function public.job_lock(text,uuid,text), public.assert_sync_lock(uuid),
  public.save_ml_auth(uuid,jsonb), public.apply_ml_snapshot(uuid,jsonb,bigint),
  public.mark_item_error(uuid,text,text,bigint) to service_role;

commit;
