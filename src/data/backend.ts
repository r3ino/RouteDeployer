import type { Collection, Season } from '../domain/catalog';
import type { PersonalDataField } from '../domain/personalData';
import type { RouteStats } from '../domain/route';
import type { Tour, TourRoute } from '../domain/tour';
import { requireSupabase } from '../lib/supabase';

interface SeasonRow {
  slug: string;
  label: string;
  sort_order: number;
}

interface CollectionRow {
  season_slug: string;
  slug: string;
  label: string;
  color: string;
  start_label: string;
  end_label: string;
  sort_order: number;
}

interface TourRow {
  id: string;
  season_slug: string;
  collection_slug: string;
  title: string;
  teaser: string;
  planned_by: string | null;
  meeting_time: string;
  meeting_place: string;
  stations: string[];
  highlight: boolean;
  duration_min: number | null;
  gpx_key: string | null;
  route_stats: RouteStats | null;
  alternative: StoredTourRoute | null;
  organizer_id: string | null;
  event_url?: string | null;
  required_personal_data?: PersonalDataField[] | null;
}

interface StoredTourRoute {
  title: string;
  teaser: string;
  plannedBy?: string | null;
  meetingTime: string;
  meetingPlace: string;
  stations: string[];
  highlight?: boolean;
  durationMin?: number | null;
  gpxKey?: string | null;
  routeStats?: RouteStats | null;
}

function routeUrl(key: string | null | undefined) {
  return key
    ? requireSupabase().storage.from('routes').getPublicUrl(key, { download: true }).data.publicUrl
    : undefined;
}

function isMissingEventUrlColumn(error: { code?: string; message: string }) {
  return error.code === '42703' && error.message.includes('event_url');
}

function toTourRoute(row: StoredTourRoute): TourRoute {
  return {
    title: row.title,
    teaser: row.teaser,
    plannedBy: row.plannedBy ?? undefined,
    meetingTime: row.meetingTime,
    meetingPlace: row.meetingPlace,
    stations: row.stations,
    highlight: row.highlight ?? undefined,
    durationMin: row.durationMin ?? undefined,
    gpx: routeUrl(row.gpxKey),
    gpxKey: row.gpxKey ?? undefined,
    routeStats: row.routeStats ?? undefined,
  };
}

export async function fetchRoadbook(): Promise<Season[]> {
  const client = requireSupabase();
  const [seasonResult, collectionResult, tourResult] = await Promise.all([
    client.from('seasons').select('slug, label, sort_order').order('sort_order'),
    client
      .from('collections')
      .select('season_slug, slug, label, color, start_label, end_label, sort_order')
      .order('sort_order'),
    (async () => {
      const withEventUrl = await client
        .from('tours')
        .select(
          'id, season_slug, collection_slug, title, teaser, planned_by, meeting_time, meeting_place, stations, highlight, duration_min, gpx_key, route_stats, alternative, organizer_id, event_url, required_personal_data',
        )
        .order('id');
      if (!withEventUrl.error || !isMissingEventUrlColumn(withEventUrl.error)) {
        return withEventUrl;
      }

      console.warn(
        'Die Supabase-Migration 202611060001_event_url.sql fehlt; Event-Links sind vorübergehend nicht verfügbar.',
      );
      return client
        .from('tours')
        .select(
          'id, season_slug, collection_slug, title, teaser, planned_by, meeting_time, meeting_place, stations, highlight, duration_min, gpx_key, route_stats, alternative, organizer_id',
        )
        .order('id');
    })(),
  ]);
  if (seasonResult.error) throw seasonResult.error;
  if (collectionResult.error) throw collectionResult.error;
  if (tourResult.error) throw tourResult.error;

  const seasons = (seasonResult.data as SeasonRow[]).map((season): Season => ({
    slug: season.slug,
    label: season.label,
    collections: (collectionResult.data as CollectionRow[])
      .filter((collection) => collection.season_slug === season.slug)
      .map((collection): Collection => ({
        slug: collection.slug,
        label: collection.label,
        color: collection.color,
        startLabel: collection.start_label,
        endLabel: collection.end_label,
        tours: (tourResult.data as TourRow[])
          .filter(
            (tour) =>
              tour.season_slug === season.slug && tour.collection_slug === collection.slug,
          )
          .map((row): Tour => ({
            id: row.id,
            seasonSlug: row.season_slug,
            collectionSlug: row.collection_slug,
            title: row.title,
            teaser: row.teaser,
            plannedBy: row.planned_by ?? undefined,
            meetingTime: row.meeting_time,
            meetingPlace: row.meeting_place,
            stations: row.stations,
            highlight: row.highlight,
            durationMin: row.duration_min ?? undefined,
            gpx: routeUrl(row.gpx_key),
            gpxKey: row.gpx_key ?? undefined,
            routeStats: row.route_stats ?? undefined,
            alternative: row.alternative ? toTourRoute(row.alternative) : undefined,
            organizerId: row.organizer_id ?? undefined,
            eventUrl:
              row.collection_slug === 'events' ? row.event_url ?? undefined : undefined,
            requiredPersonalData:
              row.collection_slug === 'events'
                ? row.required_personal_data ?? ['full_name', 'address', 'birth_date']
                : undefined,
          })),
      })),
  }));
  return seasons;
}

export async function deleteTour(tour: Tour) {
  const client = requireSupabase();
  if (!tour.seasonSlug || !tour.collectionSlug) {
    throw new Error('Bei der Tour fehlen Saison- oder Kollektion-Zuordnung.');
  }
  const { error } = await client
    .from('tours')
    .delete()
    .eq('id', tour.id)
    .eq('season_slug', tour.seasonSlug)
    .eq('collection_slug', tour.collectionSlug);
  if (error) throw error;

  const keys = [tour.gpxKey, tour.alternative?.gpxKey].filter(
    (key): key is string => key != null,
  );
  await deleteStoredRoutes(keys);
}

export async function deleteStoredRoutes(keys: string[]) {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return;
  const { error } = await requireSupabase().storage.from('routes').remove(uniqueKeys);
  if (error) throw error;
}
