import type { SupabaseClient } from '@supabase/supabase-js';
import type { DuoData, PersonId, SavingMove } from './domain';

export type PersonalInterestStatus = { annualPercent: number; settledThrough: string; startsOn: string };
export const MAX_INTEREST_RATE = 1000;

export function interestBusinessDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function shiftInterestDay(day: string, offset: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function parseAnnualPercent(value: string) {
  const text = value.trim();
  if (!/^\d{1,4}(?:[.,]\d{1,4})?$/.test(text)) return null;
  const amount = Number(text.replace(',', '.'));
  return Number.isFinite(amount) && amount >= 0 && amount <= MAX_INTEREST_RATE ? amount : null;
}

export function dailyPersonalInterest(balance: number, annualPercent: number) {
  if (!Number.isFinite(balance) || !Number.isFinite(annualPercent) || balance <= 0 || annualPercent <= 0 || annualPercent > MAX_INTEREST_RATE) return 0;
  return Math.round((balance * annualPercent / 36500 + Number.EPSILON) * 100) / 100;
}

export async function readPersonalInterest(client: SupabaseClient): Promise<PersonalInterestStatus | null> {
  const { data, error } = await client.rpc('duo_personal_interest_status');
  if (error?.code === 'PGRST202' || error?.message.includes('duo_profile_required')) return null;
  if (error) throw error;
  if (!data) return null;
  return { annualPercent: Number(data.annual_percent), settledThrough: data.settled_through, startsOn: data.starts_on };
}

export async function savePersonalInterest(client: SupabaseClient, annualPercent: number) {
  const { error } = await client.rpc('duo_set_personal_interest', { p_annual_percent: annualPercent });
  if (error?.code === 'PGRST202') throw new Error('Falta activar los rendimientos personales en Supabase.');
  if (error) throw error;
}

export async function readSharedInterest(client: SupabaseClient): Promise<PersonalInterestStatus | null> {
  const { data, error } = await client.rpc('duo_shared_interest_status');
  if (error?.code === 'PGRST202' || error?.message.includes('duo_profile_required')) return null;
  if (error) throw error;
  if (!data) return null;
  return { annualPercent: Number(data.annual_percent), settledThrough: data.settled_through, startsOn: data.starts_on };
}

export async function saveSharedInterest(client: SupabaseClient, annualPercent: number) {
  const { error } = await client.rpc('duo_set_shared_interest', { p_annual_percent: annualPercent });
  if (error?.code === 'PGRST202') throw new Error('Falta activar los rendimientos compartidos en Supabase.');
  if (error) throw error;
}

export function settleDemoSharedInterest(data: DuoData, today = interestBusinessDay()): DuoData {
  const config = data.sharedInterest;
  const through = shiftInterestDay(today, -1);
  if (!config || config.settledThrough >= through) return data;
  const savings = [...data.savings];
  for (let day = shiftInterestDay(config.settledThrough, 1); day <= through; day = shiftInterestDay(day, 1)) {
    if (!config.annualPercent) break;
    const balance = savings.filter(move => move.account === 'shared' && move.currency === 'ARS' && move.date <= day)
      .reduce((sum, move) => sum + (move.kind === 'deposit' ? move.amount : -move.amount), 0);
    const amount = dailyPersonalInterest(balance, config.annualPercent);
    const id = `shared-interest:${day}`;
    if (amount && !savings.some(move => move.id === id)) savings.push({ id, owner: 'adri', amount, date: day, currency: 'ARS', account: 'shared',
      kind: 'deposit', note: `Rendimiento calculado · ${config.annualPercent}% anual`, excludeFromMonthlyCash: true,
      interestOn: day, interestAnnualPercent: config.annualPercent, createdAt: `${shiftInterestDay(day, 1)}T03:00:00.000Z` });
  }
  return { ...data, savings, sharedInterest: { ...config, settledThrough: through } };
}

export function changeDemoSharedInterest(data: DuoData, annualPercent: number, today = interestBusinessDay()): DuoData {
  const settled = settleDemoSharedInterest(data, today);
  return { ...settled, sharedInterest: { annualPercent, settledThrough: shiftInterestDay(today, -1), startsOn: settled.sharedInterest?.startsOn ?? today } };
}

export function settleDemoInterest(data: DuoData, owner: PersonId, today = interestBusinessDay()): DuoData {
  const config = data.personalInterest?.[owner];
  const through = shiftInterestDay(today, -1);
  if (!config || config.settledThrough >= through) return data;
  const savings = [...data.savings];
  for (let day = shiftInterestDay(config.settledThrough, 1); day <= through; day = shiftInterestDay(day, 1)) {
    if (!config.annualPercent) break;
    const balance = savings.filter(move => move.owner === owner && move.account === 'personal' && move.currency === 'ARS' && move.date <= day)
      .reduce((sum, move) => sum + (move.kind === 'deposit' ? move.amount : -move.amount), 0);
    const amount = dailyPersonalInterest(balance, config.annualPercent);
    const id = `personal-interest:${owner}:${day}`;
    if (amount && !savings.some(move => move.id === id)) savings.push({ id, owner, amount, date: day, currency: 'ARS', account: 'personal',
      kind: 'deposit', note: `Rendimiento calculado · ${config.annualPercent}% anual`, excludeFromMonthlyCash: true,
      interestOn: day, interestAnnualPercent: config.annualPercent, createdAt: `${shiftInterestDay(day, 1)}T03:00:00.000Z` });
  }
  return { ...data, savings, personalInterest: { ...data.personalInterest, [owner]: { ...config, settledThrough: through } } };
}

export function changeDemoInterest(data: DuoData, owner: PersonId, annualPercent: number, today = interestBusinessDay()): DuoData {
  const settled = settleDemoInterest(data, owner, today);
  return { ...settled, personalInterest: { ...settled.personalInterest,
    [owner]: { annualPercent, settledThrough: shiftInterestDay(today, -1), startsOn: settled.personalInterest?.[owner]?.startsOn ?? today } } };
}
