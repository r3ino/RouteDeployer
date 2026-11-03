import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Collection, Season } from '../domain/catalog';
import type { Tour } from '../domain/tour';
import { fetchRoadbook } from '../data/backend';
import { supabase } from '../lib/supabase';
import { TourCalendar } from '../features/calendar/TourCalendar';
import { CollectionSwitcher } from '../features/collection-switcher/CollectionSwitcher';
import { TourDetails } from '../features/tour-details/TourDetails';
import { TourTimeline } from '../features/tour-timeline/TourTimeline';
import { CommunityAccount } from '../features/community/CommunityAccount';
import { EventEditor } from '../features/events/EventEditor';
import { useCommunityAuth } from '../features/community/useCommunityAuth';
import { todayIso } from '../shared/format/date';
import { estimateDurationMin } from '../shared/format/number';

const BASE = import.meta.env.BASE_URL;
const CHEMNITZ_WEATHER_LOCATION = {
  place: 'Chemnitz',
  latitude: 50.8278,
  longitude: 12.9214,
};

interface Location {
  season: Season;
  collection: Collection;
  tourId: string | null;
  variant: 'A' | 'B';
  isHome: boolean;
}

const pathFor = (season: Season, collection: Collection) =>
  `${BASE}${season.slug}/${collection.slug}/`;

function currentSeason(today: string, seasons: Season[]): Season {
  const availableSeasons = seasons.filter((season) => season.collections.length > 0);
  const afterWorkSeasons = availableSeasons
    .map((season) => ({
      season,
      collection: season.collections.find((collection) => collection.slug === 'after-work'),
      dates: season.collections
        .find((collection) => collection.slug === 'after-work')
        ?.tours.map((tour) => tour.id)
        .sort(),
    }))
    .filter(
      (
        entry,
      ): entry is { season: Season; collection: Collection; dates: string[] } =>
        entry.collection != null && entry.dates != null && entry.dates.length > 0,
    )
    .sort((a, b) => a.dates[0].localeCompare(b.dates[0]));

  return (
    afterWorkSeasons.find((entry) => entry.dates[0] <= today && today <= entry.dates.at(-1)!)?.season ??
    afterWorkSeasons.find((entry) => entry.dates[0] > today)?.season ??
    afterWorkSeasons.at(-1)?.season ??
    (availableSeasons.at(-1) as Season)
  );
}

/** Saison/Kollektion stecken im Pfad (<base>s27/after-work/), die Tour in ?tour=YYYY-MM-DD. */
function readLocation(seasons: Season[]): Location {
  const isHome = window.location.pathname === BASE;
  const [seasonSlug, collectionSlug] = window.location.pathname.slice(BASE.length).split('/');
  const requestedSeason = seasons.find((s) => s.slug === seasonSlug);
  const season =
    requestedSeason?.collections.length
      ? requestedSeason
      : currentSeason(todayIso(), seasons.filter((entry) => entry.collections.length > 0));
  const defaultCollection =
    season.collections.find((collection) => collection.slug === 'after-work') ?? season.collections[0];
  const collection =
    season.collections.find((c) => c.slug === collectionSlug) ?? defaultCollection;
  return {
    season,
    collection,
    tourId: new URLSearchParams(window.location.search).get('tour'),
    variant: new URLSearchParams(window.location.search).get('variant') === 'B' ? 'B' : 'A',
    isHome,
  };
}

function useLocation(seasons: Season[]) {
  const [loc, setLoc] = useState(() => readLocation(seasons));

  useEffect(() => {
    // Die Startseite bleibt für Homescreen-Verknüpfungen unter der Basis-URL.
    if (loc.isHome) return;

    // Nicht (mehr) gültige Pfade auf die aufgelöste Saison/Kollektion normalisieren.
    const expected = pathFor(loc.season, loc.collection);
    if (window.location.pathname !== expected) {
      const url = new URL(window.location.href);
      url.pathname = expected;
      window.history.replaceState(null, '', url);
    }
  }, [loc.season, loc.collection, loc.isHome]);

  useEffect(() => {
    const onPop = () => setLoc(readLocation(seasons));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [seasons]);

  const go = useCallback(
    (season: Season, collection: Collection, tourId: string | null, variant: 'A' | 'B' = 'A') => {
    const url = new URL(window.location.href);
    url.pathname = pathFor(season, collection);
    url.search = '';
    if (tourId) url.searchParams.set('tour', tourId);
    if (tourId && variant === 'B') url.searchParams.set('variant', variant);
    window.history.pushState(null, '', url);
      setLoc({ season, collection, tourId, variant, isHome: false });
    },
    [],
  );

  return [loc, go] as const;
}

const next = <T,>(items: T[], current: T) => items[(items.indexOf(current) + 1) % items.length];

function isWithinNextSevenDays(date: string, today: string): boolean {
  const toUtcDay = (value: string) => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  const daysUntil = (toUtcDay(date) - toUtcDay(today)) / 86_400_000;
  return daysUntil >= 0 && daysUntil <= 7;
}

export default function App() {
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const community = useCommunityAuth();
  const isAdmin = community.session?.user.app_metadata.role === 'admin';
  const loggedIn =
    isAdmin ||
    (community.member?.status === 'approved' && Boolean(community.member.email_confirmed_at));
  const authReady = community.authReady;

  useEffect(() => {
    let active = true;
    if (!supabase) {
      setError('Die Verbindung zur Roadbook-Datenbank ist noch nicht eingerichtet.');
      return () => {
        active = false;
      };
    }
    if (!authReady) {
      return () => {
        active = false;
      };
    }

    // Die Datenbank liefert je nach Freigabe andere Kollektionen aus, daher bei Statuswechsel neu laden.
    fetchRoadbook()
      .then((data) => {
        if (active) {
          setSeasons(data);
          setDataVersion((version) => version + 1);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Die Tourendaten konnten nicht geladen werden.');
        }
      });

    return () => {
      active = false;
    };
  }, [authReady, loggedIn, reloadVersion]);

  if (error) {
    return (
      <main className="backend-state" role="alert">
        <h1>Roadbook nicht erreichbar</h1>
        <p>{error}</p>
        <p>Bitte prüfe die Supabase-Konfiguration und die Datenbankverbindung.</p>
      </main>
    );
  }
  if (!seasons || !authReady) {
    return <main className="backend-state" aria-live="polite">Roadbook wird geladen …</main>;
  }
  if (seasons.length === 0) {
    return <main className="backend-state">Es sind noch keine Saisons angelegt.</main>;
  }
  if (!seasons.some((season) => season.collections.length > 0)) {
    return <main className="backend-state">Es sind noch keine Kollektionen angelegt.</main>;
  }

  return (
    <RoadbookGate
      seasons={seasons}
      dataVersion={dataVersion}
      onReload={() => setReloadVersion((version) => version + 1)}
      community={community}
      loggedIn={loggedIn}
    />
  );
}

const PUBLIC_COLLECTION = 'after-work';

function RoadbookGate({
  seasons,
  dataVersion,
  community,
  loggedIn,
  onReload,
}: {
  seasons: Season[];
  dataVersion: number;
  community: ReturnType<typeof useCommunityAuth>;
  loggedIn: boolean;
  onReload: () => void;
}) {
  const visibleSeasons = useMemo(
    () =>
      loggedIn
        ? seasons
        : seasons.map((season) => ({
            ...season,
            collections: season.collections.filter(
              (collection) => collection.slug === PUBLIC_COLLECTION,
            ),
          })),
    [loggedIn, seasons],
  );

  if (!visibleSeasons.some((season) => season.collections.length > 0)) {
    return <main className="backend-state">Es sind noch keine Touren veröffentlicht.</main>;
  }

  // key: Ort aus der URL neu auflösen, wenn neue Daten geladen wurden (z. B. nach Login/Freigabe)
  return (
    <Roadbook
      key={`${loggedIn}-${dataVersion}`}
      seasons={visibleSeasons}
      community={community}
      loggedIn={loggedIn}
      onReload={onReload}
    />
  );
}

function Roadbook({
  seasons,
  community,
  loggedIn,
  onReload,
}: {
  seasons: Season[];
  community: ReturnType<typeof useCommunityAuth>;
  loggedIn: boolean;
  onReload: () => void;
}) {
  const today = todayIso(new Date());
  const availableSeasons = useMemo(
    () => seasons.filter((entry) => entry.collections.length > 0),
    [seasons],
  );
  const [{ season, collection, tourId, variant }, go] = useLocation(availableSeasons);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [editor, setEditor] = useState<
    { mode: 'create' } | { mode: 'edit'; tour: Tour } | null
  >(null);
  const memberId =
    community.member?.status === 'approved' && community.member.email_confirmed_at
      ? community.session?.user.id ?? null
      : null;

  useEffect(() => {
    document.documentElement.style.setProperty('--collection-color', collection.color);
  }, [collection.color]);

  const sorted = useMemo(
    () =>
      [...collection.tours].sort(
        (a, b) =>
          a.id.slice(0, 10).localeCompare(b.id.slice(0, 10)) ||
          (a.meetingTime ?? '').localeCompare(b.meetingTime ?? '') ||
          a.id.localeCompare(b.id),
      ),
    [collection],
  );
  const selected =
    sorted.find((t) => t.id === tourId) ?? sorted.find((t) => t.id >= today) ?? sorted.at(-1);
  const displayedTour: Tour | undefined =
    selected && variant === 'B' && selected.alternative
      ? { ...selected.alternative, id: selected.id }
      : selected;
  const displayedVariant = variant === 'B' && selected?.alternative ? 'B' : 'A';
  const displayedRoute = displayedTour?.routeStats;
  const durationMin =
    displayedTour?.durationMin ??
    (displayedRoute
      ? estimateDurationMin(displayedRoute.distanceKm, displayedRoute.ascentM)
      : null);
  const routeStart = displayedRoute?.geoPath[0];
  const weatherLocation =
    displayedTour &&
    displayedTour.meetingTime &&
    (routeStart || displayedTour.meetingPlace) &&
    isWithinNextSevenDays(displayedTour.id, today)
      ? routeStart
        ? {
            place: displayedTour.stations[0] ?? 'Startpunkt',
            longitude: routeStart[0],
            latitude: routeStart[1],
          }
        : CHEMNITZ_WEATHER_LOCATION
      : undefined;

  const nextCollection = next(season.collections, collection);

  return (
    <div className="page">
      <header className="nav">
        {loggedIn && (
          <CollectionSwitcher
            collections={season.collections}
            current={collection}
            onNext={() => go(season, nextCollection, null)}
          />
        )}
        <h2 className="nav__title">
          <a href={BASE} aria-label="Zur Startseite">
            KLLKTV
          </a>
        </h2>
        <div className="nav__profile">
          <CommunityAccount
            email={community.session?.user.email ?? null}
            member={community.member}
            isAdmin={community.session?.user.app_metadata.role === 'admin'}
            loading={community.loading}
            error={community.error}
            onRefresh={community.refresh}
          />
        </div>
      </header>
      {loggedIn && calendarOpen && (
        <TourCalendar
          seasons={availableSeasons}
          selectedId={selected?.id ?? today}
          onClose={() => setCalendarOpen(false)}
          onSelect={(targetSeason, targetCollection, id) => {
            setCalendarOpen(false);
            go(targetSeason, targetCollection, id);
          }}
        />
      )}
      {selected ? (
        <main className="tour">
          <TourTimeline
            tours={sorted}
            selectedId={selected.id}
            today={today}
            onSelect={(id) => go(season, collection, id)}
            onToggleAlternative={(id) =>
              go(season, collection, id, displayedVariant === 'A' ? 'B' : 'A')
            }
            startLabel={collection.startLabel}
            endLabel={collection.endLabel}
            onOpenCalendar={loggedIn ? () => setCalendarOpen(true) : undefined}
            onAddEvent={
              memberId && collection.slug === 'events'
                ? () => setEditor({ mode: 'create' })
                : undefined
            }
          />
          <TourDetails
            tour={displayedTour ?? selected}
            seasonSlug={season.slug}
            collectionSlug={collection.slug}
            memberId={memberId}
            memberData={community.member}
            position={sorted.indexOf(selected) + 1}
            count={sorted.length}
            isPast={selected.id < today}
            route={displayedRoute}
            durationMin={durationMin}
            weatherLocation={weatherLocation}
            variant={displayedVariant}
            onVariantChange={
              selected.alternative
                ? (nextVariant) => go(season, collection, selected.id, nextVariant)
                : undefined
            }
            onEditEvent={() => setEditor({ mode: 'edit', tour: selected })}
          />
        </main>
      ) : (
        <main className="empty">
          Noch keine Touren eingetragen.
          {memberId && collection.slug === 'events' && (
            <button
              type="button"
              className="timeline__add"
              onClick={() => setEditor({ mode: 'create' })}
              aria-label="Event anlegen"
            >
              +
            </button>
          )}
        </main>
      )}
      {editor && memberId && (
        <EventEditor
          seasonSlug={season.slug}
          collectionSlug={collection.slug}
          memberId={memberId}
          tour={editor.mode === 'edit' ? editor.tour : undefined}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setEditor(null);
            go(season, collection, id);
            onReload();
          }}
          onDeleted={() => {
            setEditor(null);
            go(season, collection, null);
            onReload();
          }}
        />
      )}
    </div>
  );
}
