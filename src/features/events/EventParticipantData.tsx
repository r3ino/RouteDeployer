import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { requireSupabase } from '../../lib/supabase';
import { PERSONAL_DATA_LABELS, type PersonalDataField } from '../../domain/personalData';
import { isoToGerman } from '../../shared/format/germanInput';

interface Participant {
  user_id: string;
  display_name: string;
  full_name: string | null;
  address: string | null;
  birth_date: string | null;
}

interface Props {
  seasonSlug: string;
  collectionSlug: string;
  tourId: string;
  required: PersonalDataField[];
}

const oneLine = (value: string) => value.replace(/\s*\n\s*/g, ', ');

function describe(participant: Participant, required: PersonalDataField[]) {
  return [
    required.includes('full_name') && participant.full_name
      ? participant.full_name
      : participant.display_name,
    required.includes('address')
      ? `${PERSONAL_DATA_LABELS.address}: ${participant.address ? oneLine(participant.address) : '–'}`
      : null,
    required.includes('birth_date')
      ? `${PERSONAL_DATA_LABELS.birth_date}: ${participant.birth_date ? isoToGerman(participant.birth_date) : '–'}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function EventParticipantData({ seasonSlug, collectionSlug, tourId, required }: Props) {
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setParticipants(null);
    setError(null);
    void (async () => {
      const { data, error: rpcError } = await requireSupabase().rpc('get_event_participant_details', {
        p_season_slug: seasonSlug,
        p_collection_slug: collectionSlug,
        p_tour_id: tourId,
      });
      if (!active) return;
      if (rpcError) setError(rpcError.message);
      else setParticipants((data ?? []) as Participant[]);
    })();
    return () => {
      active = false;
    };
  }, [seasonSlug, collectionSlug, tourId]);

  async function copyAll() {
    if (!participants) return;
    try {
      await navigator.clipboard.writeText(participants.map((participant) => describe(participant, required)).join('\n\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Das Kopieren in die Zwischenablage ist fehlgeschlagen.');
    }
  }

  return (
    <div className="attendance__list events__participants">
      <h2>Teilnehmerdaten</h2>
      {error ? (
        <p className="attendance__error" role="alert">{error}</p>
      ) : !participants ? (
        <p role="status">Daten werden geladen …</p>
      ) : participants.length === 0 ? (
        <p>Noch keine Teilnehmer.</p>
      ) : (
        <>
          <ul>
            {participants.map((participant) => (
              <li key={participant.user_id} className="events__participant">
                <b>
                  {(required.includes('full_name') && participant.full_name) || participant.display_name}
                </b>
                {required.includes('address') && (
                  <span>{participant.address ? oneLine(participant.address) : 'Keine Adresse'}</span>
                )}
                {required.includes('birth_date') && (
                  <span>
                    {participant.birth_date ? isoToGerman(participant.birth_date) : 'Kein Geburtsdatum'}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="events__copy" onClick={copyAll}>
            <Copy size={14} aria-hidden="true" /> {copied ? 'Kopiert' : 'Alle kopieren'}
          </button>
        </>
      )}
    </div>
  );
}
