import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import { SEED_DATA, type DuoData } from './domain';

const STORAGE_KEY = 'duo-prototype-v1';
const COVER_KEY = 'duo-cover-photo-v1';
const COVER_PICKER_KEY = 'duo-cover-picker-v1';
const coverKey = (ownerId?: string) => ownerId ? `${COVER_KEY}:${ownerId}` : COVER_KEY;
const coverFilename = /^duo-cover-[0-9]+-[a-z0-9]+(?:\.[a-z0-9]{1,8})?$/;
const copySeedData = (): DuoData => ({
  expenses: [...SEED_DATA.expenses],
  transfers: [...SEED_DATA.transfers],
  savings: [...SEED_DATA.savings],
  incomes: [...SEED_DATA.incomes],
});

function coverFile(name: string | null) {
  return name && coverFilename.test(name) ? new File(Paths.document, name) : null;
}

async function deleteCoverFile(file: File | null) {
  try {
    if (file?.exists) await file.delete();
  } catch {
    // The saved preference has already changed. An old copy can be left in app storage.
  }
}

export async function rememberCoverPicker(ownerId?: string) {
  await AsyncStorage.setItem(COVER_PICKER_KEY, coverKey(ownerId));
}

export async function finishCoverPicker(ownerId?: string) {
  if (await AsyncStorage.getItem(COVER_PICKER_KEY) !== coverKey(ownerId)) return false;
  await AsyncStorage.removeItem(COVER_PICKER_KEY);
  return true;
}

export async function loadCoverPhoto(ownerId?: string) {
  const file = coverFile(await AsyncStorage.getItem(coverKey(ownerId)));
  return file?.exists ? file.uri : null;
}

export async function saveCoverPhoto(uri: string, id: string, ownerId?: string) {
  const key = coverKey(ownerId);
  const previous = coverFile(await AsyncStorage.getItem(key));
  const source = new File(uri);
  const extension = source.extension.toLowerCase();
  const suffix = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '';
  const name = `duo-cover-${id}${suffix}`;
  const copy = coverFile(name);
  if (!copy || copy.uri === previous?.uri) throw new Error('Invalid cover filename');
  try {
    await source.copy(copy);
    await AsyncStorage.setItem(key, name);
  } catch (error) {
    await deleteCoverFile(copy);
    throw error;
  }
  await deleteCoverFile(previous);
  return copy.uri;
}

export async function removeCoverPhoto(ownerId?: string) {
  const key = coverKey(ownerId);
  const previous = coverFile(await AsyncStorage.getItem(key));
  await AsyncStorage.removeItem(key);
  await deleteCoverFile(previous);
}

export async function loadDemoData(): Promise<DuoData> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Partial<DuoData> | null;
      if (data && Array.isArray(data.expenses) && Array.isArray(data.transfers) && Array.isArray(data.savings)) {
        return {
          expenses: data.expenses, transfers: data.transfers, savings: data.savings,
          incomes: Array.isArray(data.incomes) ? data.incomes : [],
          dueDates: Array.isArray(data.dueDates) ? data.dueDates : [],
          dueDateSchedules: Array.isArray(data.dueDateSchedules) ? data.dueDateSchedules : [],
          personalInterest: data.personalInterest && typeof data.personalInterest === 'object' ? data.personalInterest : undefined,
          sharedInterest: data.sharedInterest && typeof data.sharedInterest === 'object' ? data.sharedInterest : undefined,
          cashInterest: data.cashInterest && typeof data.cashInterest === 'object' ? data.cashInterest : undefined,
        };
      }
    }
  } catch { /* Corrupt sample data is replaced with the initial demo. */ }
  return copySeedData();
}

export async function saveDemoData(data: DuoData) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export async function resetDemoData() {
  await AsyncStorage.removeItem(STORAGE_KEY);
  return copySeedData();
}
