export type PersonalDataField = 'full_name' | 'address' | 'birth_date';

export const PERSONAL_DATA_FIELDS: PersonalDataField[] = ['full_name', 'address', 'birth_date'];

export const PERSONAL_DATA_LABELS: Record<PersonalDataField, string> = {
  full_name: 'Vollständiger Name',
  address: 'Adresse',
  birth_date: 'Geburtsdatum',
};

export interface PersonalData {
  full_name: string | null;
  address: string | null;
  birth_date: string | null;
}

const FULL_NAME = /^\p{L}[\p{L}'’.-]*(\s+\p{L}[\p{L}'’.-]*)+$/u;

function isPlausibleBirthDate(iso: string | null, now = new Date()) {
  if (!iso) return false;
  const birth = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;
  const limit = (years: number) =>
    Date.UTC(now.getFullYear() - years, now.getMonth(), now.getDate());
  return birth.getTime() <= limit(1) && birth.getTime() >= limit(120);
}

// Muss mit public.missing_personal_data (Supabase-Migration) übereinstimmen.
export function isPlausible(field: PersonalDataField, data: PersonalData | null): boolean {
  if (!data) return false;
  if (field === 'full_name') {
    const value = data.full_name?.trim() ?? '';
    return value.length >= 5 && FULL_NAME.test(value);
  }
  if (field === 'address') {
    const value = data.address?.trim() ?? '';
    return value.length >= 8 && /\p{L}/u.test(value) && /\d/.test(value);
  }
  return isPlausibleBirthDate(data.birth_date);
}

export function missingPersonalData(
  required: PersonalDataField[],
  data: PersonalData | null,
): PersonalDataField[] {
  return required.filter((field) => !isPlausible(field, data));
}
