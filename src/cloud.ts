import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CATEGORIES, recordedAtFromKey } from './domain';
import type { Category, Currency, Debt, DuoData, ExpenseDraft, Income, OtherMovement, PersonId, SavingMove, Transfer } from './domain';
import type { DueDate, DueDateChange } from './dueDates';
import type { PersonalInterestStatus } from './savingsInterest';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

export const cloudClient = url?.startsWith('https://') && key?.startsWith('sb_publishable_')
  ? createClient(url, key, {
    auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce' },
  })
  : null;

export type CloudChange =
  | { kind: 'expense'; entry: ExpenseDraft }
  | { kind: 'income'; entry: Omit<Income, 'id' | 'owner'> }
  | { kind: 'saving'; entry: Omit<SavingMove, 'id' | 'owner'> }
  | { kind: 'transfer'; entry: Pick<Transfer, 'amount' | 'date' | 'note' | 'currency'> }
  | { kind: 'debt'; entry: Pick<Debt, 'amount' | 'date' | 'note'> };

export type ExpenseChange =
  | { kind: 'edit-expense'; id: string; entry: ExpenseDraft }
  | { kind: 'delete-expense'; id: string };
export type MovementChange =
  | { kind: 'edit-movement'; movement: OtherMovement }
  | { kind: 'delete-movement'; movement: OtherMovement };

export type CloudDashboard = {
  data: DuoData;
  userId: string;
  names: Record<PersonId, string>;
  linked: boolean;
  dueDatePaymentsEnabled: boolean;
  dueDateRecurrenceEnabled: boolean;
  setDueDateViewMonth: (month: string | null) => void;
  syncError: string;
  personalInterest: PersonalInterestStatus | null;
  cashInterest: PersonalInterestStatus | null;
  setCashInterest: (annualPercent: number) => Promise<void>;
  sharedInterest: PersonalInterestStatus | null;
  setSharedInterest: (annualPercent: number) => Promise<void>;
  setPersonalInterest: (annualPercent: number) => Promise<void>;
  write: (change: CloudChange | ExpenseChange | MovementChange | DueDateChange, requestKey: string) => Promise<void>;
  refresh: () => Promise<void>;
  openAccount: () => void;
};

export type Profile = { user_id: string; display_name: string };
type LedgerKind = CloudChange['kind'] | 'expense-usd' | 'transfer-usd' | 'debt-receivable';
type MovementRow = {
  id: string; owner_id: string; pair_id: string | null; recipient_id: string | null;
  request_key: string; created_at?: string | null;
  movement_date: string; kind: LedgerKind; amount: number; currency: Currency;
  category: string | null; note: string; saving_kind: SavingMove['kind'] | null;
  exclude_from_monthly_cash?: boolean;
  cash_interest_on?: string | null; cash_interest_tna?: number | null;
  savings_interest_on?: string | null; savings_interest_tna?: number | null;
};

export async function readProfile(client: SupabaseClient, userId: string): Promise<Profile | null> {
  const { data, error } = await client.from('duo_profiles').select('user_id,display_name').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function readPartner(client: SupabaseClient): Promise<Profile | null> {
  const { data, error } = await client.rpc('duo_partner').maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

const categoryIds = new Set<string>(CATEGORIES.map(category => category.id));
const movementColumns = 'id,owner_id,pair_id,recipient_id,request_key,movement_date,kind,amount,currency,category,note,saving_kind';

type DueDateRow = {
  id: string; title: string; due_on: string; amount: number | null; currency: Currency;
  paid_on: string | null; source_id: string | null; copied_month: string | null;
  category?: string | null; payment_expense_ids?: string[];
  scheduled_day?: number | null;
  payment_window_days?: number | null;
  remind_daily?: boolean;
  due_date_schedule_id?: string | null;
  schedule?: { active: boolean } | null;
};

export async function readDueDates(client: SupabaseClient, userId: string, viewMonth: string | null = null) {
  if (viewMonth) {
    const { error } = await client.rpc('duo_generate_due_dates', { p_month: `${viewMonth}-01` });
    if (error && error.code !== 'PGRST202') throw error;
  }
  const dueDates: DueDate[] = [];
  const pageSize = 200;
  const columns = 'id,title,due_on,amount,currency,paid_on,source_id,copied_month';
  const paymentColumns = `${columns},category,payment_expense_ids` as const;
  const scheduledColumns = `${paymentColumns},scheduled_day` as const;
  const recurrenceColumns = `${scheduledColumns},due_date_schedule_id,schedule:duo_due_date_schedules!duo_due_dates_due_date_schedule_id_fkey(active)` as const;
  const reminderColumns = `${recurrenceColumns},payment_window_days,remind_daily` as const;
  let reminderColumnsEnabled = true;
  let recurrenceEnabled = true;
  let scheduledDayEnabled = true;
  let paymentsEnabled = true;
  let cursor: string | undefined;
  for (;;) {
    const selectedColumns = recurrenceEnabled ? (reminderColumnsEnabled ? reminderColumns : recurrenceColumns)
      : scheduledDayEnabled ? scheduledColumns : paymentsEnabled ? paymentColumns : columns;
    const page = client.from('duo_due_dates').select(selectedColumns)
      .eq('owner_id', userId).order('id', { ascending: true }).limit(pageSize);
    if (cursor) page.gt('id', cursor);
    const { data, error } = await page.overrideTypes<DueDateRow[], { merge: false }>();
    if (error?.code === '42703' && reminderColumnsEnabled && recurrenceEnabled) {
      reminderColumnsEnabled = false;
      continue;
    }
    if (error && recurrenceEnabled && ['42703', 'PGRST200', 'PGRST205'].includes(error.code)) {
      recurrenceEnabled = false;
      continue;
    }
    if (error?.code === 'PGRST205' || error?.code === '42P01') {
      return { dueDates: [], paymentsEnabled: false, recurrenceEnabled: false };
    }
    if (error?.code === '42703' && scheduledDayEnabled) {
      scheduledDayEnabled = false;
      continue;
    }
    if (error?.code === '42703' && paymentsEnabled) {
      paymentsEnabled = false;
      continue;
    }
    if (error) throw error;
    const rows = data;
    for (const row of rows) {
      dueDates.push({
        id: row.id, owner: 'adri', title: row.title, date: row.due_on,
        amount: row.amount === null ? null : Number(row.amount), currency: row.currency, paidOn: row.paid_on,
        copiedFrom: row.source_id ?? undefined, copiedMonth: row.copied_month?.slice(0, 7),
        category: row.category && categoryIds.has(row.category) ? row.category as Category : undefined,
        paymentExpenseIds: row.payment_expense_ids,
        scheduledDay: row.scheduled_day ?? undefined,
        paymentWindowDays: row.payment_window_days ?? undefined,
        remindDaily: row.remind_daily ?? false,
        scheduleId: row.due_date_schedule_id ?? undefined,
        repeatsMonthly: row.schedule?.active ?? false,
      });
    }
    if (rows.length < pageSize) return { dueDates, paymentsEnabled, recurrenceEnabled };
    cursor = rows[rows.length - 1].id;
  }
}

export async function writeDueDate(client: SupabaseClient, change: DueDateChange, requestKey: string, paymentsEnabled: boolean) {
  const { action } = change;
  if (action.type === 'copy') {
    const { error } = await client.rpc(action.repeatMonthly ? 'duo_repeat_due_dates' : 'duo_copy_due_dates', {
      p_month: `${action.month}-01`, p_ids: action.ids, p_key: requestKey,
    });
    if (error) throw error;
    return;
  }
  if (action.type === 'stop-recurrence') {
    const { error } = await client.rpc('duo_stop_due_date_recurrence', { p_id: action.id });
    if (error) throw error;
    return;
  }
  if (action.type === 'save' && paymentsEnabled) {
    const { draft } = action;
    const fields = {
      p_id: action.id ?? null, p_key: requestKey, p_title: draft.title, p_due_on: draft.date,
      p_amount: draft.amount, p_currency: draft.currency, p_category: draft.category ?? null,
    };
    const result = await client.rpc('duo_save_due_date_with_reminders', {
      ...fields, p_payment_window_days: draft.paymentWindowDays ?? null, p_remind_daily: draft.remindDaily ?? false,
    });
    if (result.error?.code === 'PGRST202' && draft.paymentWindowDays === undefined && !draft.remindDaily) {
      const legacy = await client.rpc('duo_save_due_date', fields);
      if (legacy.error) throw legacy.error;
    } else if (result.error) throw result.error;
    return;
  }
  if (action.type === 'pay') {
    const { error } = await client.rpc('duo_pay_due_date', {
      p_id: action.id, p_key: requestKey, p_paid_on: action.date,
      p_total: action.expense?.total ?? null, p_shared_amount: action.expense?.sharedAmount ?? null,
    });
    if (error) throw error;
    return;
  }
  const draft = action.type === 'save' ? action.draft : null;
  if (draft?.paymentWindowDays !== undefined) throw new Error('duo_due_date_reminders_unavailable');
  const { error } = await client.rpc('duo_write_due_date', {
    p_action: action.type, p_id: action.id ?? null, p_key: requestKey,
    p_title: draft?.title ?? null, p_due_on: draft?.date ?? null,
    p_amount: draft?.amount ?? null, p_currency: draft?.currency ?? null,
    p_paid_on: action.type === 'paid' ? action.date : null,
  });
  if (error) throw error;
}

export async function readMovements(client: SupabaseClient, userId: string): Promise<DuoData> {
  const debts: Debt[] = [];
  const data: DuoData = { expenses: [], incomes: [], savings: [], transfers: [], debts };
  const person = (id: string): PersonId => id === userId ? 'adri' : 'mel';
  const pageSize = 200;

  let cursor: string | null = null;
  let includeCreatedAt = true;
  let includeCashExclusion = true;
  let includeInterest = true;
  let includeCashInterest = true;
  for (;;) {
    const columns = movementColumns + (includeCreatedAt ? ',created_at' : '') + (includeCashExclusion ? ',exclude_from_monthly_cash' : '')
      + (includeInterest ? ',savings_interest_on,savings_interest_tna' : '')
      + (includeCashInterest ? ',cash_interest_on,cash_interest_tna' : '');
    const page = client.from('duo_movements')
      .select(columns)
      .order('id', { ascending: true }).limit(pageSize);
    const result = await (cursor ? page.gt('id', cursor) : page);
    if (!cursor && includeCashInterest && ['42703', 'PGRST204'].includes(result.error?.code ?? '')
      && result.error?.message.includes('cash_interest_')) {
      includeCashInterest = false;
      continue;
    }
    if (!cursor && includeInterest && ['42703', 'PGRST204'].includes(result.error?.code ?? '')
      && result.error?.message.includes('savings_interest_')) {
      includeInterest = false;
      continue;
    }
    if (!cursor && includeCreatedAt && ['42703', 'PGRST204'].includes(result.error?.code ?? '')
      && result.error?.message.includes('created_at')) {
      includeCreatedAt = false;
      continue;
    }
    if (!cursor && includeCashExclusion && result.error?.code === '42703'
      && result.error.message.includes('exclude_from_monthly_cash')) {
      includeCashExclusion = false;
      continue;
    }
    if (result.error) throw result.error;
    const rows = result.data as unknown as MovementRow[];
    for (const row of rows) {
      const common = { id: row.id, amount: Number(row.amount), date: row.movement_date,
        createdAt: row.created_at ?? recordedAtFromKey(row.request_key) };
      const owner = person(row.owner_id);
      if (row.kind === 'expense' || row.kind === 'expense-usd') {
        const category = row.category && categoryIds.has(row.category) ? row.category as Category : 'otros';
        data.expenses.push({ ...common, category, description: row.note, paidBy: owner, shared: !!row.pair_id, currency: row.currency });
      } else if (row.kind === 'income') {
        data.incomes.push({ ...common, owner, note: row.note, interestOn: row.cash_interest_on ?? undefined,
          interestAnnualPercent: row.cash_interest_tna == null ? undefined : Number(row.cash_interest_tna) });
      } else if (row.kind === 'saving' && row.saving_kind) {
        data.savings.push({
          ...common, owner, note: row.note, currency: row.currency, kind: row.saving_kind,
          account: row.pair_id ? 'shared' : 'personal',
          excludeFromMonthlyCash: row.exclude_from_monthly_cash === true,
          interestOn: row.savings_interest_on ?? undefined,
          interestAnnualPercent: row.savings_interest_tna == null ? undefined : Number(row.savings_interest_tna),
        });
      } else if (row.recipient_id) {
        const entry = { ...common, from: owner, to: person(row.recipient_id), note: row.note };
        if (row.kind === 'transfer' || row.kind === 'transfer-usd') data.transfers.push({ ...entry, currency: row.currency });
        else if (row.kind === 'debt') debts.push(entry);
        else if (row.kind === 'debt-receivable') debts.push({ ...entry, from: entry.to, to: owner, recordedBy: owner });
      }
    }
    if (rows.length < pageSize) return data;
    cursor = rows[rows.length - 1].id;
  }
}

export async function addCloudMovement(client: SupabaseClient, change: CloudChange, requestKey: string) {
  const { kind, entry } = change;
  if (kind === 'debt') {
    const { error } = await client.rpc('duo_save_debt_receivable', {
      p_request_key: requestKey, p_id: null, p_delete: false,
      p_amount: entry.amount, p_date: entry.date, p_note: entry.note,
    });
    if (error) throw error;
    return;
  }
  if (kind === 'saving' && entry.kind === 'deposit' && entry.currency === 'ARS' && entry.excludeFromMonthlyCash) {
    const { error } = await client.rpc('duo_add_saving_without_cash', {
      p_request_key: requestKey, p_amount: entry.amount, p_date: entry.date,
      p_shared: entry.account === 'shared', p_note: entry.note,
    });
    if (error) throw error;
    return;
  }
  const currency = kind === 'income' ? 'ARS' : entry.currency ?? 'ARS';
  const ledgerKind = kind === 'expense' && currency === 'USD' ? 'expense-usd'
    : kind === 'transfer' && currency === 'USD' ? 'transfer-usd' : kind;
  const { error } = await client.rpc('duo_add_movement', {
    p_request_key: requestKey,
    p_kind: ledgerKind,
    p_amount: entry.amount,
    p_date: entry.date,
    p_shared: kind === 'expense' ? entry.shared : kind === 'saving' && entry.account === 'shared',
    p_currency: currency,
    p_category: kind === 'expense' ? entry.category : null,
    p_note: kind === 'expense' ? entry.description : entry.note,
    p_saving_kind: kind === 'saving' ? entry.kind : null,
  });
  if (error) throw error;
}

export async function changeCloudExpense(client: SupabaseClient, change: ExpenseChange) {
  const entry = change.kind === 'edit-expense' ? change.entry : null;
  const { error } = await client.rpc('duo_change_expense_currency', {
    p_id: change.id,
    p_delete: entry === null,
    p_amount: entry?.amount ?? null,
    p_category: entry?.category ?? null,
    p_note: entry?.description ?? null,
    p_date: entry?.date ?? null,
    p_shared: entry?.shared ?? null,
    p_currency: entry ? entry.currency ?? 'ARS' : null,
  });
  if (error) throw error;
}

export async function changeCloudMovement(client: SupabaseClient, change: MovementChange) {
  const { movement } = change;
  const { entry } = movement;
  const deleting = change.kind === 'delete-movement';
  if (movement.kind === 'debt' && movement.entry.recordedBy === movement.entry.to) {
    const { error } = await client.rpc('duo_save_debt_receivable', {
      p_request_key: null, p_id: entry.id, p_delete: deleting,
      p_amount: deleting ? null : entry.amount,
      p_date: deleting ? null : entry.date,
      p_note: deleting ? null : entry.note,
    });
    if (error) throw error;
    return;
  }
  const saving = movement.kind === 'saving' && !deleting ? movement.entry : null;
  const { error } = await client.rpc('duo_change_movement', {
    p_id: entry.id,
    p_kind: movement.kind === 'transfer' && movement.entry.currency === 'USD' ? 'transfer-usd' : movement.kind,
    p_delete: deleting,
    p_amount: deleting ? null : entry.amount,
    p_date: deleting ? null : entry.date,
    p_note: deleting ? null : entry.note,
    p_saving_kind: saving?.kind ?? null,
    p_exclude_from_monthly_cash: saving?.excludeFromMonthlyCash ?? false,
  });
  if (error) throw error;
}

const errorMessages: Record<string, string> = {
  duo_own_invite: 'Compartile este código a la otra persona para que lo ingrese en su cuenta.',
  duo_invalid_invite: 'El código venció o ya se usó. Pedí una invitación nueva.',
  duo_already_linked: 'Esta cuenta ya está vinculada.',
  duo_link_required: 'Vinculá las dos cuentas para compartir este movimiento.',
  duo_transfer_exceeds_debt: 'El monto supera tu deuda actual. Actualizá el saldo y revisá el importe.',
  duo_insufficient_savings: 'El monto supera el saldo disponible de ese ahorro.',
  duo_invalid_movement: 'Revisá el importe y la fecha del movimiento.',
  duo_expense_unavailable: 'Este gasto ya no está disponible para editar o eliminar.',
  duo_movement_unavailable: 'Este registro ya no está disponible para editar o eliminar.',
  duo_due_date_unavailable: 'Este vencimiento ya no está disponible.',
  duo_invalid_due_date: 'Revisá el nombre, las fechas y el importe del vencimiento.',
  duo_due_date_reminders_unavailable: 'Los recordatorios todavía necesitan activarse en la cuenta de Duo.',
  duo_invalid_due_date_payment: 'Revisá el monto pagado y la parte compartida.',
  duo_due_date_expense_exists: 'Este vencimiento ya se registró. Actualizá la lista de vencimientos.',
  duo_saving_balance_negative: 'El cambio dejaría el ahorro con saldo negativo. Revisá los retiros de esa cuenta.',
  PGRST202: 'Esta actualización todavía necesita activarse en la cuenta de Duo.',
  over_request_rate_limit: 'Esperá un momento y volvé a intentar.',
  invalid_credentials: 'El correo o la contraseña son incorrectos.',
  email_not_confirmed: 'La cuenta todavía necesita confirmación en Supabase.',
  google_account_unavailable: 'Esta cuenta de Google no puede entrar a Duo. Revisá que hayas elegido el correo autorizado.',
  google_callback_invalid: 'No pudimos confirmar el acceso con Google. Volvé a intentar.',
  google_unavailable: 'El acceso con Google todavía no está disponible en esta instalación.',
};

export function cloudError(error: unknown, fallback: string) {
  if (typeof error !== 'object' || error === null) return fallback;
  const { code, message } = error as { code?: string; message?: string };
  return (message && Object.prototype.hasOwnProperty.call(errorMessages, message) && errorMessages[message])
    || (code && Object.prototype.hasOwnProperty.call(errorMessages, code) && errorMessages[code]) || fallback;
}
