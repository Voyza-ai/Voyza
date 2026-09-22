-- 006: atomic canvas save — replace a trip's cities + transports in one
-- transaction.
--
-- The canvas save (backend/src/routes/canvas.ts, POST /:tripId/save) used
-- to DELETE the trip's transports and cities and then INSERT the new ones
-- as separate statements, with the insert error only logged. An insert
-- that failed after the delete had gone through left the trip with NO
-- cities while the client was still told `{ saved: true }`.
--
-- The Supabase JS client has no transactions, so the only way to make the
-- replace atomic is a database function: a plpgsql function body runs in
-- one transaction, so either every statement below lands or none does —
-- a failed insert rolls the delete back too.
--
-- Contract (mirrors what the route builds):
--   p_cities     jsonb array of `cities` rows, snake_case column names,
--                each carrying its `position` (0-based, in itinerary order).
--   p_transports jsonb array of `transports` rows, snake_case column names,
--                but keyed by `from_position` / `to_position` instead of
--                city ids — the new ids only exist once this function has
--                inserted the cities, so it resolves them itself. A leg
--                whose endpoints aren't both in p_cities is skipped.
--   returns      the number of cities written.
--
-- The backend calls this with the service role. It is deliberately
-- SECURITY INVOKER (RLS still applies to any other caller) and EXECUTE is
-- revoked from the browser-facing roles: the function takes a trip id and
-- deletes that trip's rows, so it must not be reachable through
-- /rest/v1/rpc/ by a signed-in user. (Same hardening the SECURITY TODO in
-- SCHEMA_SNAPSHOT.sql calls for on the existing functions.)
--
-- Until this is applied the route falls back to an ordered, non-atomic
-- insert-then-delete and logs a warning naming this file.
--
-- Run in the Supabase SQL editor (same as 001–005), or:
--   supabase db push

create or replace function public.canvas_replace_trip_graph(
  p_trip_id uuid,
  p_cities jsonb,
  p_transports jsonb
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_city jsonb;
  v_transport jsonb;
  v_new_id uuid;
  v_id_by_position jsonb := '{}'::jsonb;
  v_count integer := 0;
begin
  -- Transports FK to cities, so they go first.
  delete from public.transports where trip_id = p_trip_id;
  delete from public.cities where trip_id = p_trip_id;

  for v_city in select value from jsonb_array_elements(coalesce(p_cities, '[]'::jsonb))
  loop
    insert into public.cities (
      trip_id,
      name,
      country,
      arrival_date,
      departure_date,
      color_index,
      position,
      hotel,
      hotels,
      selected_hotel_index,
      custom_hotel,
      vibes,
      activities,
      restaurants,
      schedule
    ) values (
      p_trip_id,
      v_city->>'name',
      coalesce(v_city->>'country', ''),
      nullif(v_city->>'arrival_date', '')::date,
      nullif(v_city->>'departure_date', '')::date,
      coalesce((v_city->>'color_index')::integer, 0),
      (v_city->>'position')::integer,
      -- JSON null (a city with no hotel) must land as SQL NULL, not the
      -- jsonb value 'null'.
      nullif(v_city->'hotel', 'null'::jsonb),
      coalesce(nullif(v_city->'hotels', 'null'::jsonb), '[]'::jsonb),
      coalesce((v_city->>'selected_hotel_index')::integer, 0),
      nullif(v_city->'custom_hotel', 'null'::jsonb),
      coalesce(nullif(v_city->'vibes', 'null'::jsonb), '[]'::jsonb),
      coalesce(nullif(v_city->'activities', 'null'::jsonb), '[]'::jsonb),
      coalesce(nullif(v_city->'restaurants', 'null'::jsonb), '[]'::jsonb),
      coalesce(nullif(v_city->'schedule', 'null'::jsonb), '{}'::jsonb)
    )
    returning id into v_new_id;

    v_id_by_position := v_id_by_position
      || jsonb_build_object(v_city->>'position', v_new_id::text);
    v_count := v_count + 1;
  end loop;

  for v_transport in select value from jsonb_array_elements(coalesce(p_transports, '[]'::jsonb))
  loop
    -- Skip a leg whose endpoints weren't both written above (matches the
    -- route's fallback, which filters the same way).
    continue when (v_id_by_position ->> (v_transport->>'from_position')) is null
               or (v_id_by_position ->> (v_transport->>'to_position')) is null;

    insert into public.transports (
      trip_id,
      from_city_id,
      to_city_id,
      mode,
      operator,
      price,
      duration_minutes,
      depart_time,
      arrive_time,
      depart_date,
      layovers,
      stops,
      currency,
      carrier_code,
      flight_number,
      alternatives,
      booking_url
    ) values (
      p_trip_id,
      (v_id_by_position ->> (v_transport->>'from_position'))::uuid,
      (v_id_by_position ->> (v_transport->>'to_position'))::uuid,
      coalesce(v_transport->>'mode', 'flight'),
      coalesce(v_transport->>'operator', ''),
      coalesce((v_transport->>'price')::numeric, 0),
      (v_transport->>'duration_minutes')::integer,
      v_transport->>'depart_time',
      v_transport->>'arrive_time',
      nullif(v_transport->>'depart_date', '')::date,
      (v_transport->>'layovers')::integer,
      (v_transport->>'stops')::integer,
      coalesce(v_transport->>'currency', 'USD'),
      v_transport->>'carrier_code',
      v_transport->>'flight_number',
      nullif(v_transport->'alternatives', 'null'::jsonb),
      v_transport->>'booking_url'
    );
  end loop;

  return v_count;
end;
$$;

-- Backend (service role) only — see the header.
revoke execute on function public.canvas_replace_trip_graph(uuid, jsonb, jsonb) from public;
revoke execute on function public.canvas_replace_trip_graph(uuid, jsonb, jsonb) from anon, authenticated;
grant execute on function public.canvas_replace_trip_graph(uuid, jsonb, jsonb) to service_role;

-- PostgREST has to see the new function before /rest/v1/rpc/ can route to
-- it. Supabase reloads on DDL automatically; this makes it immediate.
notify pgrst, 'reload schema';
