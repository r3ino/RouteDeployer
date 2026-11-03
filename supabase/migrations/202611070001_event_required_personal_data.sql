-- Der Organisator wählt je Event, welche persönlichen Daten für eine Zusage erforderlich sind.
-- Nur diese Daten müssen plausibel hinterlegt sein und werden ihm in der Teilnehmerliste angezeigt.

alter table public.tours
  add column required_personal_data text[] not null
    default array['full_name', 'address', 'birth_date']
    check (required_personal_data <@ array['full_name', 'address', 'birth_date']);

-- Liefert die erforderlichen Felder, die beim Mitglied fehlen oder unplausibel sind.
create function public.missing_personal_data(p_user_id uuid, p_required text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(field order by field), array[]::text[])
  from unnest(p_required) as field
  left join public.community_members as members on members.user_id = p_user_id
  where members.user_id is null
     or (field = 'full_name' and not (
          char_length(btrim(coalesce(members.full_name, ''))) >= 5
          and btrim(members.full_name) ~ '^[[:alpha:]][[:alpha:]''’.-]*(\s+[[:alpha:]][[:alpha:]''’.-]*)+$'
        ))
     or (field = 'address' and not (
          char_length(btrim(coalesce(members.address, ''))) >= 8
          and members.address ~ '[[:alpha:]]'
          and members.address ~ '[0-9]'
        ))
     or (field = 'birth_date' and not (
          members.birth_date is not null
          and members.birth_date <= current_date - interval '1 year'
          and members.birth_date >= current_date - interval '120 years'
        ));
$$;

revoke all on function public.missing_personal_data(uuid, text[]) from public, anon, authenticated;

-- Zusage nur mit Einwilligung und plausiblen Daten für die erforderlichen Felder.
create or replace function public.require_event_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  required text[];
  missing text[];
begin
  if new.collection_slug <> 'events' then
    return new;
  end if;

  select tours.required_personal_data
  into required
  from public.tours as tours
  where tours.season_slug = new.season_slug
    and tours.collection_slug = new.collection_slug
    and tours.id = new.tour_id;

  if coalesce(cardinality(required), 0) = 0 then
    return new;
  end if;

  if not new.share_personal_data then
    raise exception 'Für dieses Event ist die Einwilligung zur Weitergabe der persönlichen Daten erforderlich';
  end if;

  missing := public.missing_personal_data(new.user_id, required);
  if cardinality(missing) > 0 then
    raise exception 'Bitte hinterlege zuerst plausible persönliche Daten in deinem Profil: %',
      array_to_string(missing, ', ');
  end if;
  return new;
end;
$$;

-- Die Auswahl ist nach der Erstellung fix, damit die Einwilligungen der Teilnehmer gültig bleiben.
create function public.lock_event_required_personal_data()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.required_personal_data is distinct from old.required_personal_data
     and auth.uid() is not null
     and coalesce((select auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin' then
    raise exception 'Die erforderlichen persönlichen Daten eines Events sind nicht änderbar';
  end if;
  return new;
end;
$$;

create trigger lock_event_required_personal_data_before_update
  before update on public.tours
  for each row execute function public.lock_event_required_personal_data();

-- Teilnehmerliste: nur die erforderlichen Felder, nur bei erteilter Einwilligung.
drop function public.get_event_participant_details(text, text, text);

create function public.get_event_participant_details(
  p_season_slug text,
  p_collection_slug text,
  p_tour_id text
)
returns table (
  user_id uuid,
  display_name text,
  full_name text,
  address text,
  birth_date date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  required text[];
begin
  select tours.required_personal_data
  into required
  from public.tours as tours
  where tours.season_slug = p_season_slug
    and tours.collection_slug = p_collection_slug
    and tours.id = p_tour_id
    and tours.organizer_id = (select auth.uid());

  if not found then
    raise exception 'Nur der Organisator darf die Teilnehmerdaten abfragen';
  end if;

  return query
  select
    members.user_id,
    members.display_name,
    case when rsvps.share_personal_data and 'full_name' = any(required) then members.full_name end,
    case when rsvps.share_personal_data and 'address' = any(required) then members.address end,
    case when rsvps.share_personal_data and 'birth_date' = any(required) then members.birth_date end
  from public.community_rsvps as rsvps
  join public.community_members as members on members.user_id = rsvps.user_id
  where rsvps.season_slug = p_season_slug
    and rsvps.collection_slug = p_collection_slug
    and rsvps.tour_id = p_tour_id
  order by rsvps.created_at;
end;
$$;

revoke all on function public.get_event_participant_details(text, text, text) from public, anon;
grant execute on function public.get_event_participant_details(text, text, text) to authenticated;
