import { CATEGORIES, CATEGORY_GROUPS, getExpenseActivity } from './domain';
import type { Category, CategoryGroup, DuoData, PersonId } from './domain';

export type SearchDate =
  | { kind: 'day'; day: number; month: number; year?: number }
  | { kind: 'month'; month: number; year?: number }
  | { kind: 'range'; from: string; to: string };
export type ExpenseSearch = { query: string; payer?: PersonId; category?: Category | CategoryGroup; date?: SearchDate };
export type SearchActivity = ReturnType<typeof getExpenseActivity>[number];
type Names = Record<PersonId, string>;
export type SearchSuggestion = {
  id: string; label: string; consumed: string;
} & ({ kind: 'payer'; value: PersonId } | { kind: 'category'; value: Category | CategoryGroup } | { kind: 'date'; value: SearchDate });
export const EMPTY_EXPENSE_SEARCH: ExpenseSearch = { query: '' };
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const categoryInfo = new Map(CATEGORIES.map(item => [item.id, item]));
const groupInfo = new Map(CATEGORY_GROUPS.map(item => [item.id, item]));
const categoryChoices = [...CATEGORY_GROUPS, ...CATEGORIES];

export function normalizeSearch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function searchPersonAliases(name: string) {
  const normalized = normalizeSearch(name);
  const aliases = [normalized, normalized.split(' ')[0]];
  // Cloud IDs are relative to the signed-in account. Aliases follow the real name.
  if (/^marce(?:lo)?(?:\s|$)/.test(normalized)) aliases.push('marce', 'marcelo');
  if (/^mel(?:anie)?(?:\s|$)/.test(normalized)) aliases.push('mel', 'melanie');
  return aliases.filter(Boolean);
}

function validDay(day: number, month: number, year = 2000) {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function numericDate(token: string): SearchDate | undefined {
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
  if (match) {
    const [, y, m, d] = match.map(Number);
    return validDay(d, m, y) ? { kind: 'day', day: d, month: m, year: y } : undefined;
  }
  match = /^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{4}))?$/.exec(token);
  if (match) {
    const day = Number(match[1]), month = Number(match[2]), year = match[3] ? Number(match[3]) : undefined;
    return validDay(day, month, year) ? { kind: 'day', day, month, year } : undefined;
  }
  match = /^(?:(\d{4})-(\d{1,2})|(\d{1,2})\/(\d{4}))$/.exec(token);
  if (match) {
    const month = Number(match[2] ?? match[3]), year = Number(match[1] ?? match[4]);
    if (month >= 1 && month <= 12 && year >= 1000 && year <= 9999) return { kind: 'month', month, year };
  }
}

export function matchesSearchDate(date: string, filter: SearchDate) {
  if (filter.kind === 'range') return (!filter.from || date >= filter.from) && (!filter.to || date <= filter.to);
  const [year, month, day] = date.split('-').map(Number);
  return month === filter.month && (!filter.year || year === filter.year) && (filter.kind === 'month' || day === filter.day);
}

export function searchDateLabel(date: SearchDate) {
  if (date.kind === 'range') {
    const pretty = (value: string) => value.split('-').reverse().join('/');
    if (!date.from) return `Hasta ${pretty(date.to)}`;
    if (!date.to) return `Desde ${pretty(date.from)}`;
    return `${pretty(date.from)} – ${pretty(date.to)}`;
  }
  const month = MONTHS[date.month - 1];
  return `${date.kind === 'day' ? `${date.day} de ` : ''}${month}${date.year ? ` de ${date.year}` : ' · todos los años'}`;
}

export function searchDateRange(date?: SearchDate): { from: string; to: string } {
  if (!date) return { from: '', to: '' };
  if (date.kind === 'range') return { from: date.from, to: date.to };
  if (!date.year) return { from: '', to: '' };
  const prefix = `${date.year}-${String(date.month).padStart(2, '0')}`;
  if (date.kind === 'day') {
    const value = `${prefix}-${String(date.day).padStart(2, '0')}`;
    return { from: value, to: value };
  }
  return { from: `${prefix}-01`, to: `${prefix}-${new Date(date.year, date.month, 0).getDate()}` };
}

export function validSearchRange(date?: SearchDate) {
  if (!date) return true;
  if (date.kind === 'day') return validDay(date.day, date.month, date.year);
  if (date.kind === 'month') return date.month >= 1 && date.month <= 12
    && (date.year === undefined || (date.year >= 1000 && date.year <= 9999));
  const valid = (value: string) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && (() => {
    const [year, month, day] = value.split('-').map(Number);
    return validDay(day, month, year);
  })());
  return valid(date.from) && valid(date.to) && (!date.from || !date.to || date.from <= date.to);
}

export function searchCategoryLabel(category: Category | CategoryGroup) {
  return categoryInfo.get(category as Category)?.label ?? groupInfo.get(category as CategoryGroup)?.label ?? category;
}

function itemCategory(item: SearchActivity) { return item.kind === 'expense' ? categoryInfo.get(item.entry.category) : undefined; }
function itemPayer(item: SearchActivity) { return item.kind === 'expense' ? item.entry.paidBy : item.entry.owner; }

export function buildExpenseSearchIndex(data: DuoData, active: PersonId, names: Names) {
  // Enforce visibility before indexing, even when demo data contains both users' personal records.
  return getExpenseActivity(data, active, 'all').map(activity => {
    const category = itemCategory(activity);
    const [year, month, day] = activity.entry.date.split('-');
    const savingTitle = activity.kind === 'personal-savings'
      ? activity.entry.currency === 'ARS' && !activity.entry.excludeFromMonthlyCash ? 'Pasado a ahorro personal' : 'Aporte al ahorro personal' : '';
    const description = activity.kind === 'expense' ? activity.entry.description : activity.entry.note;
    const text = normalizeSearch([
      description, category?.label, category?.id, category?.group ? groupInfo.get(category.group)?.label : '',
      ...searchPersonAliases(names[itemPayer(activity)]), savingTitle,
      MONTHS[Number(month) - 1], String(Number(day)), year,
    ].join(' '));
    return { activity, text, payer: itemPayer(activity), category: category?.id, group: category?.group };
  });
}

export function filterExpenseSearch(index: ReturnType<typeof buildExpenseSearchIndex>, search: ExpenseSearch) {
  if (!validSearchRange(search.date)) return [];
  const tokens = normalizeSearch(search.query).split(' ').filter(Boolean).map(token => ({ token, date: numericDate(token) }));
  return index.filter(item => {
    if (search.payer && item.payer !== search.payer) return false;
    if (search.category && item.category !== search.category && item.group !== search.category) return false;
    if (search.date && !matchesSearchDate(item.activity.entry.date, search.date)) return false;
    return tokens.every(({ token, date }) => {
      if (date) return matchesSearchDate(item.activity.entry.date, date);
      if (/^\d+[/.\-]\d/.test(token)) return false;
      return item.text.includes(token);
    });
  }).map(item => item.activity);
}

function phraseForAlias(words: string[], aliases: string[]) {
  for (let length = Math.min(4, words.length); length > 0; length--) {
    for (let start = 0; start <= words.length - length; start++) {
      const phrase = words.slice(start, start + length).join(' ');
      if (aliases.some(alias => alias.startsWith(phrase) || (length === 1 && alias.split(' ').some(word => word.startsWith(phrase))))) return phrase;
    }
  }
}

export function expenseSearchSuggestions(query: string, names: Names): SearchSuggestion[] {
  const words = normalizeSearch(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const suggestions: SearchSuggestion[] = [];
  for (const person of ['adri', 'mel'] as const) {
    const consumed = phraseForAlias(words, searchPersonAliases(names[person]));
    if (consumed) suggestions.push({ kind: 'payer', id: `payer-${person}`, value: person, label: `Pagó ${names[person]}`, consumed });
  }
  for (let i = 0; i < words.length; i++) {
    const parsed = numericDate(words[i]);
    const monthIndex = words[i].length >= 3 ? MONTHS.findIndex(month => month.startsWith(words[i])) : -1;
    const followingYear = /^\d{4}$/.test(words[i + 1] ?? '') ? Number(words[i + 1]) : undefined;
    const date: SearchDate | undefined = parsed ?? (monthIndex >= 0 ? { kind: 'month', month: monthIndex + 1, year: followingYear } : undefined);
    if (date && validSearchRange(date)) suggestions.push({ kind: 'date', id: `date-${i}`, value: date, label: searchDateLabel(date),
      consumed: words.slice(i, i + (!parsed && followingYear ? 2 : 1)).join(' ') });
  }
  for (const category of categoryChoices) {
    const consumed = phraseForAlias(words, [normalizeSearch(category.label), normalizeSearch(category.id).replace(/-/g, ' ')]);
    if (consumed) suggestions.push({ kind: 'category', id: `category-${category.id}`, value: category.id, label: category.label, consumed });
  }
  return suggestions.slice(0, 10);
}

export function applySearchSuggestion(search: ExpenseSearch, suggestion: SearchSuggestion): ExpenseSearch {
  const words = search.query.trim().split(/\s+/);
  const consumed = suggestion.consumed.split(' ');
  let start = -1;
  for (let i = 0; i <= words.length - consumed.length; i++) {
    if (words.slice(i, i + consumed.length).every((word, offset) => normalizeSearch(word) === consumed[offset])) { start = i; break; }
  }
  const query = (start < 0 ? words : words.filter((_, index) => index < start || index >= start + consumed.length)).join(' ');
  if (suggestion.kind === 'payer') return { ...search, query, payer: suggestion.value };
  if (suggestion.kind === 'category') return { ...search, query, category: suggestion.value };
  return { ...search, query, date: suggestion.value };
}

export function hasExpenseSearch(search: ExpenseSearch) {
  return !!(search.query.trim() || search.payer || search.category || search.date);
}
