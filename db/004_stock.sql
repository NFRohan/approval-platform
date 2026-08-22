-- =====================================================================
-- Stock movement.
--
-- These three functions were called by the movement-orders screen and
-- carried in the API whitelist, but were never ported: no definition
-- existed in any file, and none existed in the database. Three of the
-- four call sites logged the failure to the console and carried on, so
-- reservations silently never happened and reserved_quantity never moved.
--
-- SECURITY INVOKER, deliberately. They run as app_api like everything
-- else, so row-level security decides which rows are even visible and a
-- caller cannot reach another tenant's stock through them.
--
-- Quantities are guarded here *and* by the check constraints on
-- item_stock. The constraints are the truth; these raises exist so the
-- screen can say what went wrong instead of showing a constraint name.
-- =====================================================================

begin;

create or replace function public.reserve_stock(
  p_item_id uuid, p_venue_id uuid, p_qty int
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_available int;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'reserve: quantity must be positive';
  end if;

  select quantity - reserved_quantity into v_available
    from public.item_stock
   where item_id = p_item_id and venue_id = p_venue_id
     for update;

  if not found then
    raise exception 'reserve: this item is not stocked at that venue';
  end if;

  if v_available < p_qty then
    raise exception 'reserve: only % available, % requested', v_available, p_qty;
  end if;

  update public.item_stock
     set reserved_quantity = reserved_quantity + p_qty
   where item_id = p_item_id and venue_id = p_venue_id;
end $$;

create or replace function public.release_reservation(
  p_item_id uuid, p_venue_id uuid, p_qty int
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'release: quantity must be positive';
  end if;

  -- Floored at zero rather than raising. Releasing more than is held
  -- means the caller lost track, and refusing would strand the stock
  -- reserved forever; the reservation is advisory, the quantity is not.
  update public.item_stock
     set reserved_quantity = greatest(0, reserved_quantity - p_qty)
   where item_id = p_item_id and venue_id = p_venue_id;
end $$;

create or replace function public.transfer_stock(
  p_item_id uuid, p_from_venue uuid, p_to_venue uuid, p_qty int
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_unreserved int;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'transfer: quantity must be positive';
  end if;
  if p_from_venue is null or p_to_venue is null then
    raise exception 'transfer: both venues are required';
  end if;
  if p_from_venue = p_to_venue then
    raise exception 'transfer: source and destination are the same venue';
  end if;

  select quantity - reserved_quantity into v_unreserved
    from public.item_stock
   where item_id = p_item_id and venue_id = p_from_venue
     for update;

  if not found then
    raise exception 'transfer: this item is not stocked at the source venue';
  end if;

  -- Only unreserved stock may leave. Anything reserved is spoken for by
  -- another order that has not completed yet.
  if v_unreserved < p_qty then
    raise exception 'transfer: only % unreserved, % requested', v_unreserved, p_qty;
  end if;

  update public.item_stock
     set quantity = quantity - p_qty
   where item_id = p_item_id and venue_id = p_from_venue;

  -- The destination may not stock this item yet. tenant_id comes from
  -- the column default, so the new row lands in the caller's tenant and
  -- nowhere else.
  insert into public.item_stock (item_id, venue_id, quantity)
  values (p_item_id, p_to_venue, p_qty)
  on conflict (item_id, venue_id)
  do update set quantity = public.item_stock.quantity + excluded.quantity;
end $$;

grant execute on function
  public.reserve_stock(uuid, uuid, int),
  public.release_reservation(uuid, uuid, int),
  public.transfer_stock(uuid, uuid, uuid, int)
to app_api;

commit;
