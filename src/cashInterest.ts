import type { SupabaseClient } from '@supabase/supabase-js';
import { getMonthlyCash } from './domain';
import type { DuoData, PersonId } from './domain';
import { dailyPersonalInterest, interestBusinessDay, shiftInterestDay } from './savingsInterest';
import type { PersonalInterestStatus } from './savingsInterest';

export async function readCashInterest(client: SupabaseClient): Promise<PersonalInterestStatus | null> {
  const { data, error } = await client.rpc('duo_cash_interest_status');
  if (error?.code === 'PGRST202' || error?.message?.includes('duo_profile_required')) return null;
  if (error) throw error;
  if (!data) return null;
  return { annualPercent: Number(data.annual_percent), settledThrough: data.settled_through, startsOn: data.starts_on };
}

export async function saveCashInterest(client: SupabaseClient, annualPercent: number) {
  const { error } = await client.rpc('duo_set_cash_interest', { p_annual_percent: annualPercent });
  if (error?.code === 'PGRST202') throw new Error('Falta activar los rendimientos del disponible en Supabase.');
  if (error) throw error;
}

export function settleDemoCashInterest(data: DuoData, owner: PersonId, today = interestBusinessDay()): DuoData {
  const config = data.cashInterest?.[owner];
  const through = shiftInterestDay(today, -1);
  if (!config || config.settledThrough >= through) return data;
  const incomes = [...data.incomes];
  for (let day = shiftInterestDay(config.settledThrough, 1); day <= through; day = shiftInterestDay(day, 1)) {
    if (!config.annualPercent) break;
    const balance = getMonthlyCash({ ...data, incomes }, owner, day.slice(0, 7), day).remaining;
    const amount = dailyPersonalInterest(balance, config.annualPercent);
    const id = `cash-interest:${owner}:${day}`;
    if (amount && !incomes.some(entry => entry.id === id)) incomes.push({ id, owner, amount, date: day,
      note: `Rendimiento del disponible · ${config.annualPercent}% anual`, interestOn: day, interestAnnualPercent: config.annualPercent });
  }
  return { ...data, incomes, cashInterest: { ...data.cashInterest, [owner]: { ...config, settledThrough: through } } };
}

export function changeDemoCashInterest(data: DuoData, owner: PersonId, annualPercent: number, today = interestBusinessDay()): DuoData {
  const settled = settleDemoCashInterest(data, owner, today);
  return { ...settled, cashInterest: { ...settled.cashInterest,
    [owner]: { annualPercent, settledThrough: shiftInterestDay(today, -1), startsOn: settled.cashInterest?.[owner]?.startsOn ?? today } } };
}
