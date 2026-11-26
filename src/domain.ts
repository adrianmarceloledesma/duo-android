import type { DueDate, DueDateSchedule } from './dueDates';
import type { PersonalInterestStatus } from './savingsInterest';

export type PersonId = 'adri' | 'mel';
export type Currency = 'ARS' | 'USD';
export type Category =
  | 'supermercado' | 'verduleria' | 'panaderia' | 'carniceria' | 'compras' | 'tarjeta-credito'
  | 'luz' | 'gas' | 'expensas' | 'agua' | 'internet' | 'hogar'
  | 'seguro' | 'nafta' | 'patente' | 'mecanico' | 'otros-auto'
  | 'gym' | 'voley' | 'padel'
  | 'youtube' | 'chatgpt' | 'netflix' | 'microsoft' | 'spotify' | 'adobe'
  | 'salidas' | 'vacaciones' | 'salud' | 'otros' | 'monotributo' | 'expedicion-sonrisa' | 'sube' | 'indira'
  | 'uber' | 'tren' | 'omnibus' | 'heladeria' | 'farmacia' | 'pedidos-ya'
  | 'peaje' | 'lavadero' | 'accesorios-auto' | 'comida' | 'cine' | 'teatro'
  | 'tuenti' | 'personal-movil' | 'claro' | 'movistar' | 'otro-celular'
  | 'bbva' | 'santander' | 'galicia' | 'uala' | 'naranja-x' | 'banco-nacion' | 'banco-provincia' | 'macro' | 'icbc';
export type CategoryGroup = 'casa' | 'auto' | 'deportes' | 'suscripciones' | 'varios' | 'celular' | 'tarjetas' | 'transporte' | 'mas-compras' | 'salidas-grupo';
export type Tab = 'gastos' | 'vencimientos' | 'ahorros' | 'analisis';
export type Expense = { id: string; amount: number; category: Category; description: string; date: string; paidBy: PersonId; shared: boolean; currency?: Currency; createdAt?: string };
export type ExpenseDraft = Omit<Expense, 'id' | 'paidBy' | 'createdAt'>;
export type Income = { id: string; amount: number; date: string; owner: PersonId; note: string; interestOn?: string; interestAnnualPercent?: number };
export type Transfer = { id: string; amount: number; date: string; from: PersonId; to: PersonId; note: string; currency?: Currency };
export type Debt = Omit<Transfer, 'currency'> & { recordedBy?: PersonId };
export type SavingMove = {
  id: string;
  createdAt?: string;
  amount: number;
  date: string;
  currency: Currency;
  account: 'personal' | 'shared';
  owner: PersonId;
  kind: 'deposit' | 'withdraw';
  note: string;
  excludeFromMonthlyCash?: boolean;
  interestOn?: string;
  interestAnnualPercent?: number;
};
export type DuoData = {
  expenses: Expense[]; transfers: Transfer[]; savings: SavingMove[]; incomes: Income[]; debts?: Debt[];
  dueDates?: DueDate[]; dueDateSchedules?: DueDateSchedule[];
  personalInterest?: Partial<Record<PersonId, PersonalInterestStatus>>;
  sharedInterest?: PersonalInterestStatus;
  cashInterest?: Partial<Record<PersonId, PersonalInterestStatus>>;
};
export type OtherMovement =
  | { kind: 'income'; entry: Income }
  | { kind: 'saving'; entry: SavingMove }
  | { kind: 'transfer'; entry: Transfer }
  | { kind: 'debt'; entry: Debt };

export function movementOwner(movement: OtherMovement): PersonId {
  if (movement.kind === 'debt') return movement.entry.recordedBy ?? movement.entry.from;
  return movement.kind === 'transfer' ? movement.entry.from : movement.entry.owner;
}

export function findMovement(data: DuoData, kind: OtherMovement['kind'], id: string): OtherMovement | undefined {
  if (kind === 'income') {
    const entry = data.incomes.find(item => item.id === id);
    if (entry) return { kind, entry };
  } else if (kind === 'transfer') {
    const entry = data.transfers.find(item => item.id === id);
    if (entry) return { kind, entry };
  } else if (kind === 'debt') {
    const entry = data.debts?.find(item => item.id === id);
    if (entry) return { kind, entry };
  } else {
    const entry = data.savings.find(item => item.id === id);
    if (entry) return { kind, entry };
  }
}

function reviseList<T extends { id: string }>(items: T[], entry: T, remove: boolean): T[] {
  return remove ? items.filter(item => item.id !== entry.id)
    : items.map(item => item.id === entry.id ? entry : item);
}

export function reviseMovement(data: DuoData, movement: OtherMovement, remove: boolean): DuoData {
  switch (movement.kind) {
    case 'income': return { ...data, incomes: reviseList(data.incomes, movement.entry, remove) };
    case 'saving': return { ...data, savings: reviseList(data.savings, movement.entry, remove) };
    case 'transfer': return { ...data, transfers: reviseList(data.transfers, movement.entry, remove) };
    case 'debt': return { ...data, debts: reviseList(data.debts ?? [], movement.entry, remove) };
  }
}
export type ExpenseFilter = 'all' | 'shared' | 'personal';
type ExpenseActivity =
  | { kind: 'expense'; entry: Expense }
  | { kind: 'personal-savings'; entry: SavingMove };

export const PEOPLE: Record<PersonId, string> = { adri: 'Marce', mel: 'Mel' };
export const CATEGORIES: { id: Category; label: string; icon: string; color: string; group?: CategoryGroup }[] = [
  { id: 'supermercado', label: 'Supermercado', icon: '🛒', color: '#e4f1e7' },
  { id: 'verduleria', label: 'Verdulería', icon: '🥬', color: '#eff2dc' },
  { id: 'panaderia', label: 'Panadería', icon: '🥖', color: '#f5efd9' },
  { id: 'compras', label: 'Shopping', icon: '🛍️', color: '#f6e9df' },
  { id: 'bbva', label: 'BBVA', icon: '💳', color: '#dceaff', group: 'tarjetas' },
  { id: 'santander', label: 'Santander', icon: '💳', color: '#ffe3da', group: 'tarjetas' },
  { id: 'galicia', label: 'Galicia', icon: '💳', color: '#ffedc7', group: 'tarjetas' },
  { id: 'uala', label: 'Ualá', icon: '💳', color: '#e4e7ff', group: 'tarjetas' },
  { id: 'naranja-x', label: 'Naranja X', icon: '💳', color: '#ffedc7', group: 'tarjetas' },
  { id: 'banco-nacion', label: 'Banco Nación', icon: '💳', color: '#d9f3fb', group: 'tarjetas' },
  { id: 'banco-provincia', label: 'Banco Provincia', icon: '💳', color: '#dceaff', group: 'tarjetas' },
  { id: 'macro', label: 'Macro', icon: '💳', color: '#ede3ff', group: 'tarjetas' },
  { id: 'icbc', label: 'ICBC', icon: '💳', color: '#ffe0ed', group: 'tarjetas' },
  { id: 'tarjeta-credito', label: 'Otra tarjeta', icon: '💳', color: '#e3edf3', group: 'tarjetas' },
  { id: 'tuenti', label: 'Tuenti', icon: '📱', color: '#ede3ff', group: 'celular' },
  { id: 'personal-movil', label: 'Personal', icon: '📱', color: '#d9f3fb', group: 'celular' },
  { id: 'claro', label: 'Claro', icon: '📱', color: '#ffe3da', group: 'celular' },
  { id: 'movistar', label: 'Movistar', icon: '📱', color: '#dceaff', group: 'celular' },
  { id: 'otro-celular', label: 'Otro operador', icon: '📱', color: '#e4e7ff', group: 'celular' },
  { id: 'monotributo', label: 'Monotributo', icon: '🧾', color: '#ffedc7', group: 'varios' },
  { id: 'luz', label: 'Edesur', icon: '💡', color: '#f5efd9', group: 'casa' },
  { id: 'gas', label: 'Metrogas', icon: '🔥', color: '#f8e7de', group: 'casa' },
  { id: 'expensas', label: 'Expensas', icon: '🏢', color: '#ede9f4', group: 'casa' },
  { id: 'agua', label: 'Agua', icon: '💧', color: '#e3edf3', group: 'casa' },
  { id: 'internet', label: 'Internet', icon: '🌐', color: '#e4f1e7', group: 'casa' },
  { id: 'hogar', label: 'Otros de casa', icon: '🏠', color: '#ece9f5', group: 'casa' },
  { id: 'seguro', label: 'Seguro', icon: '🛡️', color: '#e4f1e7', group: 'auto' },
  { id: 'nafta', label: 'Nafta', icon: '⛽', color: '#e3edf3', group: 'auto' },
  { id: 'patente', label: 'Patente', icon: '🪪', color: '#f5efd9', group: 'auto' },
  { id: 'mecanico', label: 'Mecánico', icon: '🔧', color: '#f6e9df', group: 'auto' },
  { id: 'peaje', label: 'Peaje', icon: '·', color: '#d9f3fb', group: 'auto' },
  { id: 'lavadero', label: 'Lavadero', icon: '·', color: '#d9f3fb', group: 'auto' },
  { id: 'accesorios-auto', label: 'Accesorios', icon: '·', color: '#d9f3fb', group: 'auto' },
  { id: 'otros-auto', label: 'Otros de auto', icon: '🚗', color: '#e3edf3', group: 'auto' },
  { id: 'gym', label: 'Gym', icon: '🏋️', color: '#e3edf3', group: 'deportes' },
  { id: 'voley', label: 'Vóley', icon: '🏐', color: '#f5efd9', group: 'deportes' },
  { id: 'padel', label: 'Pádel', icon: '🎾', color: '#eff2dc', group: 'deportes' },
  { id: 'youtube', label: 'YouTube', icon: '▶️', color: '#f6e5e3', group: 'suscripciones' },
  { id: 'chatgpt', label: 'ChatGPT', icon: '💬', color: '#e4f1e7', group: 'suscripciones' },
  { id: 'netflix', label: 'Netflix', icon: '🎬', color: '#f6e5e3', group: 'suscripciones' },
  { id: 'microsoft', label: 'Microsoft', icon: '🖥️', color: '#e3edf3', group: 'suscripciones' },
  { id: 'spotify', label: 'Spotify', icon: '🎧', color: '#e4f1e7', group: 'suscripciones' },
  { id: 'adobe', label: 'Adobe', icon: '✐', color: '#f6e5e3', group: 'suscripciones' },
  { id: 'vacaciones', label: 'Vacaciones', icon: '🏖️', color: '#f5efd9', group: 'varios' },
  { id: 'salud', label: 'Salud', icon: '🩺', color: '#f6e5e3', group: 'varios' },
  { id: 'expedicion-sonrisa', label: 'Expedición Sonrisa', icon: '♡', color: '#e3edf3', group: 'varios' },
  { id: 'sube', label: 'SUBE', icon: '💳', color: '#d9f3fb', group: 'transporte' },
  { id: 'uber', label: 'Uber', icon: '·', color: '#d9f3fb', group: 'transporte' },
  { id: 'tren', label: 'Tren', icon: '·', color: '#d9f3fb', group: 'transporte' },
  { id: 'omnibus', label: 'Ómnibus', icon: '·', color: '#d9f3fb', group: 'transporte' },
  { id: 'heladeria', label: 'Heladería', icon: '·', color: '#d9f3fb', group: 'mas-compras' },
  { id: 'farmacia', label: 'Farmacia', icon: '·', color: '#d9f3fb', group: 'mas-compras' },
  { id: 'pedidos-ya', label: 'Pedidos Ya', icon: '·', color: '#d9f3fb', group: 'mas-compras' },
  { id: 'carniceria', label: 'Carnicería', icon: '🥩', color: '#f6e5e3', group: 'mas-compras' },
  { id: 'indira', label: 'Indira', icon: '🐱', color: '#d9f3fb', group: 'mas-compras' },
  { id: 'comida', label: 'Comida', icon: '·', color: '#d9f3fb', group: 'salidas-grupo' },
  { id: 'cine', label: 'Cine', icon: '·', color: '#d9f3fb', group: 'salidas-grupo' },
  { id: 'teatro', label: 'Teatro', icon: '·', color: '#d9f3fb', group: 'salidas-grupo' },
  { id: 'salidas', label: 'Otros', icon: '🍽️', color: '#f4e5ed', group: 'salidas-grupo' },
  { id: 'otros', label: 'Otros gastos', icon: '···', color: '#eeeae2', group: 'varios' },
];


export const CATEGORY_GROUPS = ([
  { id: 'casa', label: 'Casa', icon: '🏠', color: '#ece9f5' },
  { id: 'auto', label: 'Auto', icon: '🚗', color: '#e3edf3' },
  { id: 'transporte', label: 'Transporte', icon: '🚌', color: '#d9f3fb' },
  { id: 'mas-compras', label: 'Más compras', icon: '🛍️', color: '#d9f3fb' },
  { id: 'salidas-grupo', label: 'Salidas', icon: '🍽️', color: '#d9f3fb' },
  { id: 'celular', label: 'Celular', icon: '📱', color: '#d9f3fb' },
  { id: 'tarjetas', label: 'Tarjeta de crédito', icon: '💳', color: '#e4e7ff' },
  { id: 'deportes', label: 'Deportes', icon: '🏅', color: '#eff2dc' },
  { id: 'suscripciones', label: 'Suscripciones', icon: '🔁', color: '#ece9f5' },
  { id: 'varios', label: 'Otros', icon: '···', color: '#eeeae2' },
] as const).map(group => ({
  ...group,
  children: CATEGORIES.filter(category => category.group === group.id),
}));

export const CATEGORY_PICKER = [...CATEGORY_GROUPS, ...CATEGORIES.filter(category => !category.group)];

const month = new Date();
const currentMonth = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
const day = (n: number) => `${currentMonth}-${String(n).padStart(2, '0')}`;
export const SEED_DATA: DuoData = {
  expenses: [
    { id: 'e1', amount: 68450, category: 'supermercado', description: 'Compra semanal', date: day(13), paidBy: 'adri', shared: true },
    { id: 'e2', amount: 11200, category: 'verduleria', description: 'Fruta y verdura', date: day(12), paidBy: 'mel', shared: true },
    { id: 'e3', amount: 38900, category: 'luz', description: 'Factura de electricidad', date: day(10), paidBy: 'adri', shared: true },
    { id: 'e4', amount: 24800, category: 'nafta', description: 'Estación de servicio', date: day(9), paidBy: 'mel', shared: true },
    { id: 'e5', amount: 15400, category: 'salidas', description: 'Café con amigas', date: day(8), paidBy: 'adri', shared: false },
    { id: 'e6', amount: 9200, category: 'gas', description: 'Gas', date: day(6), paidBy: 'adri', shared: true },
    { id: 'e7', amount: 32200, category: 'compras', description: 'Zapatillas', date: day(4), paidBy: 'mel', shared: false },
    { id: 'e8', amount: 52300, category: 'supermercado', description: 'Compra del mes', date: `${previousMonth()}-29`, paidBy: 'mel', shared: true },
    { id: 'e9', amount: 26700, category: 'hogar', description: 'Artículos de limpieza', date: `${previousMonth()}-20`, paidBy: 'adri', shared: true },
    { id: 'e10', amount: 30500, category: 'nafta', description: 'Llenado de tanque', date: `${previousMonth()}-11`, paidBy: 'adri', shared: true },
  ],
  transfers: [
    { id: 't1', amount: 10000, date: day(5), from: 'mel', to: 'adri', note: 'Parte de la cuenta' },
    { id: 't2', amount: 8000, date: `${previousMonth()}-25`, from: 'mel', to: 'adri', note: 'Pago parcial' },
  ],
  incomes: [
    { id: 'i1', amount: 850000, date: day(1), owner: 'adri', note: 'Sueldo' },
    { id: 'i2', amount: 800000, date: day(1), owner: 'mel', note: 'Sueldo' },
    { id: 'i3', amount: 810000, date: `${previousMonth()}-01`, owner: 'adri', note: 'Sueldo' },
    { id: 'i4', amount: 760000, date: `${previousMonth()}-01`, owner: 'mel', note: 'Sueldo' },
  ],
  savings: [
    { id: 's1', amount: 120000, date: day(2), currency: 'ARS', account: 'personal', owner: 'adri', kind: 'deposit', note: 'Ahorro del sueldo' },
    { id: 's2', amount: 80, date: `${previousMonth()}-22`, currency: 'USD', account: 'personal', owner: 'adri', kind: 'deposit', note: 'Dólares' },
    { id: 's3', amount: 95000, date: day(1), currency: 'ARS', account: 'shared', owner: 'adri', kind: 'deposit', note: 'Ahorro de casa' },
    { id: 's4', amount: 50000, date: day(3), currency: 'ARS', account: 'shared', owner: 'mel', kind: 'deposit', note: 'Aporte de Mel' },
    { id: 's5', amount: 250, date: `${previousMonth()}-18`, currency: 'USD', account: 'shared', owner: 'mel', kind: 'deposit', note: 'Ahorro compartido' },
  ],
};

export function previousMonth(source = currentMonth) {
  const d = new Date(`${source}-15T12:00:00`); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthName(month: string) {
  return new Intl.DateTimeFormat('es-AR', { month: 'long' }).format(new Date(`${month}-15T12:00:00`));
}

export function cashHeading(month: string, thisMonth: string) {
  if (month < thisMonth) return `Te quedó en ${monthName(month)}`;
  if (month > thisMonth) return `Disponible de ${monthName(month)}`;
  return 'Te queda del mes';
}

export function monthKey(date: string) { return date.slice(0, 7); }

export function recordedAtFromKey(key?: string): string | undefined {
  const match = key && /^(\d{13})[-:]/.exec(key);
  if (!match) return;
  const time = Number(match[1]);
  if (time < 946684800000 || time >= 4102444800000) return;
  return new Date(time).toISOString();
}

function addedTime(entry: { id: string; createdAt?: string }) {
  const value = entry.createdAt ?? recordedAtFromKey(entry.id);
  if (!value) return null;
  const milliseconds = Date.parse(value.replace(/(\.\d{3})\d+(?=Z|[+-])/, '$1'));
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = /\.\d{3}(\d{1,3})/.exec(value)?.[1];
  return milliseconds * 1000 + Number(fraction?.padEnd(3, '0') ?? 0);
}

export function compareAddedTime(a: { id: string; date: string; createdAt?: string }, b: { id: string; date: string; createdAt?: string }) {
  const first = addedTime(a), second = addedTime(b);
  if (first !== null && second !== null) return second - first;
  if (first !== null) return -1;
  if (second !== null) return 1;
  // Old records without a creation timestamp retain their previous chronological fallback.
  return b.date.localeCompare(a.date);
}

export function getExpenseActivity(data: DuoData, active: PersonId, filter: ExpenseFilter) {
  const activity: ExpenseActivity[] = [];
  for (const expense of data.expenses) {
    if (!expense.shared && expense.paidBy !== active) continue;
    if (filter !== 'all' && expense.shared !== (filter === 'shared')) continue;
    activity.push({ kind: 'expense', entry: expense });
  }
  if (filter !== 'shared') {
    for (const move of data.savings) {
      if (move.owner === active && move.account === 'personal' && move.kind === 'deposit' && !move.interestOn) {
        activity.push({ kind: 'personal-savings', entry: move });
      }
    }
  }
  return activity.sort((a, b) => compareAddedTime(a.entry, b.entry));
}

export function formatMoneyInput(input: string): string | null {
  const text = input.trim();
  if (!/^[0-9.]*$/.test(text)) return null;
  const digits = text.replace(/\./g, '').replace(/^0+(?=\d)/, '');
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function parseMoneyInput(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : null;
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(input)) return null;
  const amount = Number(input.replace(/\./g, ''));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export function exactBalanceOption(balance: number): number | null {
  return Number.isFinite(balance) && balance > 0 && !Number.isInteger(balance) ? balance : null;
}

export function getMonthlyCash(data: DuoData, active: PersonId, month: string, throughDate?: string) {
  const inPeriod = (date: string) => monthKey(date) === month && (!throughDate || date <= throughDate);
  const incomes = data.incomes
    .filter(entry => entry.owner === active && inPeriod(entry.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  const interestTotal = incomes.filter(entry => !!entry.interestOn).reduce((total, entry) => total + entry.amount, 0);
  const incomeTotal = incomes.reduce((total, entry) => total + entry.amount, 0);
  const expensesPaid = data.expenses
    .filter(expense => expense.paidBy === active && expense.currency !== 'USD' && inPeriod(expense.date))
    .reduce((total, expense) => total + expense.amount, 0);
  let received = 0;
  let sent = 0;
  for (const transfer of data.transfers) {
    if (transfer.currency === 'USD' || !inPeriod(transfer.date)) continue;
    if (transfer.to === active) received += transfer.amount;
    if (transfer.from === active) sent += transfer.amount;
  }
  let savingsDeposits = 0;
  let savingsWithdrawals = 0;
  for (const move of data.savings) {
    if (move.owner !== active || move.currency !== 'ARS' || !inPeriod(move.date)) continue;
    if (move.kind === 'withdraw') savingsWithdrawals += move.amount;
    else if (!move.excludeFromMonthlyCash) savingsDeposits += move.amount;
  }
  const remaining = incomeTotal + received + savingsWithdrawals - expensesPaid - sent - savingsDeposits;
  return { incomes, incomeTotal, interestTotal, expensesPaid, received, sent, savingsDeposits, savingsWithdrawals, remaining };
}

export function getBalance(data: DuoData, active: PersonId, currency: Currency = 'ARS') {
  const partner: PersonId = active === 'adri' ? 'mel' : 'adri';
  const common = data.expenses.filter((e) => e.shared && (e.currency ?? 'ARS') === currency);
  const paid = common.reduce((sum, e) => sum + (e.paidBy === active ? e.amount : 0), 0);
  const half = common.reduce((sum, e) => sum + e.amount / 2, 0);
  const payments = data.transfers.filter(t => (t.currency ?? 'ARS') === currency);
  const paymentCents = payments.reduce((sum, t) => sum + (t.from === active ? 1 : -1) * Math.round(t.amount * 100), 0);
  const debtCents = currency === 'USD'
    ? (data.debts ?? []).reduce((sum, debt) => sum + (debt.from === active ? -1 : 1) * Math.round(debt.amount * 100), 0)
    : 0;
  const net = (Math.round((paid - half) * 100) + paymentCents + debtCents) / 100;
  return { net, paid, half, partner };
}
export function getSavingsBalance(data: DuoData, account: 'personal' | 'shared', owner: PersonId, currency: Currency) {
  return data.savings.filter((m) => m.account === account && m.currency === currency && (account === 'shared' || m.owner === owner))
    .reduce((sum, m) => sum + (m.kind === 'deposit' ? m.amount : -m.amount), 0);
}
export function getMetrics(expenses: Expense[], active: PersonId, selectedMonth: string, mode: 'own' | 'attributed' | 'shared', currency: Currency = 'ARS') {
  const movements = expenses.filter(e => (e.currency ?? 'ARS') === currency);
  const current = movements.filter((e) => monthKey(e.date) === selectedMonth);
  const own = current.filter((e) => e.paidBy === active).reduce((sum, e) => sum + e.amount, 0);
  const attributed = current.filter((e) => e.paidBy === active && !e.shared).reduce((sum, e) => sum + e.amount, 0)
    + current.filter((e) => e.shared).reduce((sum, e) => sum + e.amount / 2, 0);
  const shared = current.filter((e) => e.shared).reduce((sum, e) => sum + e.amount, 0);
  const categories = CATEGORIES.map((category) => ({ ...category,
    amount: current.filter((e) => e.category === category.id && (mode === 'shared' ? e.shared : mode === 'own' ? e.paidBy === active : e.shared || e.paidBy === active))
      .reduce((sum, e) => sum + (mode === 'shared' ? e.amount : mode === 'own' || !e.shared ? e.amount : e.amount / 2), 0),
  })).filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
  const prev = previousMonth(selectedMonth);
  const old = movements.filter((e) => monthKey(e.date) === prev);
  const previousOwn = old.filter((e) => e.paidBy === active).reduce((sum, e) => sum + e.amount, 0);
  const previousAttributed = old.reduce((sum, e) => sum + (e.shared ? e.amount / 2 : e.paidBy === active ? e.amount : 0), 0);
  const previousShared = old.filter((e) => e.shared).reduce((sum, e) => sum + e.amount, 0);
  return { own, attributed, shared, categories, previousOwn, previousAttributed, previousShared };
}
