import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Tour } from '../../domain/tour';
import { deleteStoredRoutes, deleteTour } from '../../data/backend';
import {
  PERSONAL_DATA_FIELDS,
  PERSONAL_DATA_LABELS,
  type PersonalDataField,
} from '../../domain/personalData';
import { requireSupabase } from '../../lib/supabase';
import {
  formatGermanDateInput,
  formatTimeInput,
  isoToGerman,
  isValidTime,
  parseGermanDate,
} from '../../shared/format/germanInput';
import { todayIso } from '../../shared/format/date';
import { analyzeGpx } from '../admin/analyzeGpx';
import '../community/community.css';

interface Props {
  seasonSlug: string;
  collectionSlug: string;
  memberId: string;
  tour?: Tour;
  onClose: () => void;
  onSaved: (tourId: string) => void;
  onDeleted: () => void;
}

const randomSuffix = () => crypto.randomUUID().replace(/-/g, '').slice(0, 6);

function errorText(cause: unknown) {
  if (
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    cause.code === '42703' &&
    'message' in cause &&
    String(cause.message).includes('event_url')
  ) {
    return 'Event-Links sind noch nicht verfügbar. Bitte zuerst die Supabase-Migration 202611060001_event_url.sql anwenden.';
  }
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === 'object' && 'message' in cause) return String(cause.message);
  return 'Das Event konnte nicht gespeichert werden.';
}

export function EventEditor({
  seasonSlug,
  collectionSlug,
  memberId,
  tour,
  onClose,
  onSaved,
  onDeleted,
}: Props) {
  const [title, setTitle] = useState(tour?.title ?? '');
  const [teaser, setTeaser] = useState(tour?.teaser ?? '');
  const [date, setDate] = useState(tour ? isoToGerman(tour.id.slice(0, 10)) : '');
  const [time, setTime] = useState(tour?.meetingTime ?? '');
  const [place, setPlace] = useState(tour?.meetingPlace ?? '');
  const [eventUrl, setEventUrl] = useState(tour?.eventUrl ?? '');
  const [stations, setStations] = useState(tour?.stations.join(', ') ?? '');
  const [duration, setDuration] = useState(tour?.durationMin ? String(tour.durationMin) : '');
  const [requiredData, setRequiredData] = useState<PersonalDataField[]>(
    tour?.requiredPersonalData ?? PERSONAL_DATA_FIELDS,
  );
  const [file, setFile] = useState<File | null>(null);
  const [removeGpx, setRemoveGpx] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const iso = parseGermanDate(date);
    if (!iso) return setError('Bitte ein gültiges Datum im Format TT.MM.JJJJ eingeben.');
    const unchangedDate = tour && tour.id.slice(0, 10) === iso;
    if (!unchangedDate && iso < todayIso(new Date())) {
      return setError('Das Datum darf nicht in der Vergangenheit liegen.');
    }
    if (time && !isValidTime(time)) return setError('Bitte eine Uhrzeit im Format HH:MM eingeben.');
    const trimmedEventUrl = eventUrl.trim();
    if (collectionSlug === 'events' && trimmedEventUrl) {
      try {
        const parsedUrl = new URL(trimmedEventUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return setError('Der Link muss mit http:// oder https:// beginnen.');
        }
      } catch {
        return setError('Bitte einen gültigen Link eingeben.');
      }
    }
    const durationMin = duration.trim() ? Number(duration) : null;
    if (durationMin !== null && (!Number.isFinite(durationMin) || durationMin <= 0)) {
      return setError('Die Dauer muss eine positive Zahl (Minuten) sein.');
    }

    setBusy(true);
    let uploadedKey: string | null = null;
    let persisted = false;
    try {
      const client = requireSupabase();
      const suffix = tour?.id.length && tour.id.length > 10 ? tour.id.slice(11) : randomSuffix();
      const id = `${iso}-${suffix}`;

      let gpxKey = removeGpx ? null : tour?.gpxKey ?? null;
      let routeStats = removeGpx ? null : tour?.routeStats ?? null;
      if (file) {
        routeStats = await analyzeGpx(file);
        const name = file.name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '');
        gpxKey = `member-events/${memberId}/${crypto.randomUUID()}-${name}`;
        const { error: uploadError } = await client.storage.from('routes').upload(gpxKey, file, {
          cacheControl: '3600',
          contentType: 'application/gpx+xml',
          upsert: false,
        });
        if (uploadError) throw uploadError;
        uploadedKey = gpxKey;
      }

      const values = {
        id,
        title: title.trim(),
        teaser: teaser.trim(),
        meeting_time: time,
        meeting_place: place.trim(),
        stations: stations.split(',').map((station) => station.trim()).filter(Boolean),
        duration_min: durationMin,
        gpx_key: gpxKey,
        route_stats: routeStats,
        ...(collectionSlug === 'events' ? { event_url: trimmedEventUrl || null } : {}),
      };

      if (tour) {
        const { error: updateError } = await client
          .from('tours')
          .update(values)
          .eq('id', tour.id)
          .eq('season_slug', seasonSlug)
          .eq('collection_slug', collectionSlug);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await client.from('tours').insert({
          ...values,
          season_slug: seasonSlug,
          collection_slug: collectionSlug,
          organizer_id: memberId,
          ...(collectionSlug === 'events' ? { required_personal_data: requiredData } : {}),
          highlight: false,
        });
        if (insertError) throw insertError;
      }
      persisted = true;

      if (tour?.gpxKey && tour.gpxKey !== gpxKey) {
        await deleteStoredRoutes([tour.gpxKey]).catch(() => undefined);
      }
      onSaved(id);
    } catch (cause) {
      if (!persisted && uploadedKey) {
        await deleteStoredRoutes([uploadedKey]).catch(() => undefined);
      }
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!tour) return;
    if (!window.confirm('Dieses Event wirklich löschen? Alle Zusagen gehen verloren.')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteTour(tour);
      onDeleted();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="community__overlay" role="dialog" aria-modal="true" aria-labelledby="event-editor-title">
      <button className="community__backdrop" type="button" aria-label="Schließen" onClick={onClose} />
      <section className="community__panel">
        <header className="community__header">
          <h2 id="event-editor-title">{tour ? 'Event bearbeiten' : 'Event anlegen'}</h2>
          <button className="community__close" type="button" aria-label="Schließen" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="community__content">
          <form className="community__form" onSubmit={save}>
            <label>
              Titel
              <input maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <label>
              Beschreibung
              <textarea
                rows={3}
                maxLength={600}
                value={teaser}
                onChange={(e) => setTeaser(e.target.value)}
                required
              />
            </label>
            <label>
              Datum
              <input
                inputMode="numeric"
                placeholder="TT.MM.JJJJ"
                maxLength={10}
                value={date}
                onChange={(e) => setDate(formatGermanDateInput(e.target.value))}
                required
              />
            </label>
            <label>
              Uhrzeit
              <input
                inputMode="numeric"
                placeholder="HH:MM"
                maxLength={5}
                value={time}
                onChange={(e) => setTime(formatTimeInput(e.target.value))}
              />
            </label>
            <label>
              Treffpunkt
              <input maxLength={120} value={place} onChange={(e) => setPlace(e.target.value)} />
            </label>
            {collectionSlug === 'events' && (
              <label>
                Link (optional)
                <input
                  type="url"
                  maxLength={2048}
                  placeholder="https://beispiel.de"
                  value={eventUrl}
                  onChange={(e) => setEventUrl(e.target.value)}
                />
              </label>
            )}
            {collectionSlug === 'events' && (
              <fieldset className="events__required">
                <legend>Für die Zusage erforderliche persönliche Daten</legend>
                {PERSONAL_DATA_FIELDS.map((field) => (
                  <label key={field} className="events__check">
                    <input
                      type="checkbox"
                      checked={requiredData.includes(field)}
                      disabled={Boolean(tour)}
                      onChange={(e) =>
                        setRequiredData((current) =>
                          e.target.checked
                            ? PERSONAL_DATA_FIELDS.filter((f) => f === field || current.includes(f))
                            : current.filter((f) => f !== field),
                        )
                      }
                    />
                    {PERSONAL_DATA_LABELS[field]}
                  </label>
                ))}
                <small>
                  Nur diese Angaben müssen Teilnehmer plausibel hinterlegt haben; sie werden dir in
                  der Teilnehmerliste angezeigt.
                  {tour && ' Die Auswahl ist nach dem Anlegen nicht mehr änderbar.'}
                </small>
              </fieldset>
            )}
            <label>
              Orte (mit Komma getrennt)
              <input value={stations} onChange={(e) => setStations(e.target.value)} />
            </label>
            <label>
              Dauer in Minuten (optional)
              <input
                inputMode="numeric"
                value={duration}
                onChange={(e) => setDuration(e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <label>
              GPX-Datei (optional)
              <input
                type="file"
                accept=".gpx,application/gpx+xml"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setRemoveGpx(false);
                }}
              />
            </label>
            {tour?.gpxKey && !file && (
              <label className="events__check">
                <input
                  type="checkbox"
                  checked={removeGpx}
                  onChange={(e) => setRemoveGpx(e.target.checked)}
                />
                Bestehende GPX-Datei entfernen
              </label>
            )}
            {error && <p className="community__message community__message--error" role="alert">{error}</p>}
            <button className="community__submit" type="submit" disabled={busy}>
              {busy ? 'Wird gespeichert …' : tour ? 'Speichern' : 'Event anlegen'}
            </button>
            {tour && (
              <button
                className="community__submit events__delete"
                type="button"
                onClick={remove}
                disabled={busy}
              >
                Event löschen
              </button>
            )}
          </form>
        </div>
      </section>
    </div>,
    document.body,
  );
}
