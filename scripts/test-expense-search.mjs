import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function load(relative, imports = {}) {
  const source = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInNewContext(outputText, { exports, Date, Map, Set, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected dependency: ${name}`);
    return imports[name];
  } });
  return exports;
}
const domain = await load('src/domain.ts');
const search = await load('src/expenseSearch.ts', { './domain': domain });
const names = { adri: 'Marce', mel: 'Mel' };
const expense = (id, paidBy, shared, category, date, description = '', currency = 'ARS') => ({
  id, paidBy, shared, category, date, description, currency, amount: currency === 'USD' ? 250 : 20000,
});
const data = {
  expenses: [
    expense('own-private', 'adri', false, 'supermercado', '2026-11-18', 'Compra de la semana'),
    expense('own-shared', 'adri', true, 'luz', '2026-11-17', 'Factura de electricidad'),
    expense('partner-shared', 'mel', true, 'supermercado', '2026-11-15', 'Compra del domingo'),
    expense('partner-old', 'mel', true, 'supermercado', '2025-11-15', 'Compra anterior'),
    expense('partner-october', 'mel', true, 'gas', '2026-10-31', 'Factura'),
    expense('partner-private', 'mel', false, 'supermercado', '2026-11-14', 'private-needle'),
    expense('dollars', 'adri', true, 'compras', '2026-02-28', 'Repuesto del auto', 'USD'),
    expense('leap', 'adri', false, 'nafta', '2024-02-29', 'Última carga'),
    expense('sports', 'adri', false, 'voley', '2026-11-18', 'Vóley de los miércoles'),
  ],
  savings: [
    { id: 'saving-own', date: '2026-11-01', account: 'personal', owner: 'adri', kind: 'deposit', currency: 'ARS', amount: 5000, note: 'Reserva de noviembre' },
    { id: 'saving-partner', date: '2026-11-02', account: 'personal', owner: 'mel', kind: 'deposit', currency: 'USD', amount: 200, note: 'saving-private-needle' },
    { id: 'saving-shared', date: '2026-11-03', account: 'shared', owner: 'mel', kind: 'deposit', currency: 'USD', amount: 300, note: 'Shared savings' },
  ], incomes: [], transfers: [], debts: [],
};
const before = JSON.stringify(data);
const balanceBefore = JSON.stringify(domain.getBalance(data, 'adri'));
const dollarsBefore = JSON.stringify(domain.getBalance(data, 'adri', 'USD'));
const index = search.buildExpenseSearchIndex(data, 'adri', names);
const ids = criteria => [...search.filterExpenseSearch(index, { query: '', ...criteria })].map(item => item.entry.id);
const sortedIds = criteria => ids(criteria).sort();

assert.equal(index.length, 9);
assert.deepEqual(ids({}), [...domain.getExpenseActivity(data, 'adri', 'all')].map(item => item.entry.id));
assert.equal(index.some(item => item.text.includes('private-needle')), false, 'Partner personal data entered the search index');
assert.equal(ids({ query: 'private-needle' }).length, 0);
assert.equal(ids({ query: 'saving-private-needle' }).length, 0);
assert.deepEqual(sortedIds({ payer: 'mel' }), ['partner-october', 'partner-old', 'partner-shared']);
assert.deepEqual(sortedIds({ query: 'Marcelo' }), sortedIds({ payer: 'adri' }));
assert.deepEqual(sortedIds({ query: '  VÓLEY   MIÉRCOLES  ' }), ['sports']);
assert.deepEqual(sortedIds({ query: 'voley miercoles' }), ['sports']);
assert.deepEqual(sortedIds({ query: 'mel supermercado noviembre 2026' }), ['partner-shared']);
assert.deepEqual(sortedIds({ query: 'repuesto' }), ['dollars']);
assert.deepEqual(sortedIds({ category: 'casa' }), ['own-shared', 'partner-october']);
assert.deepEqual(sortedIds({ category: 'luz' }), ['own-shared']);
assert.deepEqual(sortedIds({ query: 'luz' }), ['own-shared']);
assert.deepEqual(sortedIds({ query: 'Metrogás' }), ['partner-october']);
assert.deepEqual(sortedIds({ query: 'ahorro personal' }), ['saving-own']);
assert.deepEqual(sortedIds({ category: 'deportes' }), ['sports']);
assert.deepEqual(sortedIds({ query: 'no-such-description' }), []);
assert.deepEqual(sortedIds({ payer: 'adri', category: 'supermercado', query: 'semana', date: { kind: 'month', month: 11, year: 2026 } }), ['own-private']);
assert.deepEqual(sortedIds({ payer: 'mel', category: 'supermercado', date: { kind: 'range', from: '2026-11-01', to: '2026-11-30' } }), ['partner-shared']);

for (const query of ['18/11/2026', '18-11-2026', '18.11.2026', '2026-11-18']) {
  assert.deepEqual(sortedIds({ query }), ['own-private', 'sports'], `Date failed: ${query}`);
}
assert.deepEqual(sortedIds({ query: '15/11' }), ['partner-old', 'partner-shared']);
assert.deepEqual(sortedIds({ query: '2026-11' }), sortedIds({ query: '11/2026' }));
assert.equal(ids({ query: 'noviembre' }).includes('partner-old'), true);
for (const query of ['31/02/2026', '2026-02-29', '2026-13-01', '40/11/2026']) assert.deepEqual(ids({ query }), []);
assert.deepEqual(sortedIds({ query: '29/2/2024' }), ['leap']);
assert.deepEqual(sortedIds({ query: '29/02' }), ['leap']);
assert.deepEqual(sortedIds({ date: { kind: 'range', from: '2026-11-17', to: '2026-11-18' } }), ['own-private', 'own-shared', 'sports']);
assert.deepEqual(sortedIds({ date: { kind: 'range', from: '', to: '2025-12-31' } }), ['leap', 'partner-old']);
assert.deepEqual(sortedIds({ date: { kind: 'range', from: '2026-11-18', to: '' } }), ['own-private', 'sports']);
assert.equal(search.validSearchRange({ kind: 'range', from: '2026-11-30', to: '2026-11-01' }), false);
assert.equal(search.validSearchRange({ kind: 'range', from: '2026-02-29', to: '' }), false);
assert.equal(search.validSearchRange({ kind: 'month', month: 11, year: 0 }), false);
assert.deepEqual(ids({ date: { kind: 'range', from: '2026-12-01', to: '2026-11-01' } }), []);
assert.equal(search.searchDateRange({ kind: 'month', month: 2, year: 2024 }).to, '2024-02-29');
assert.equal(search.searchDateRange({ kind: 'month', month: 2, year: 2026 }).to, '2026-02-28');
assert.equal(search.searchDateRange({ kind: 'day', day: 3, month: 2, year: 2026 }).from, '2026-02-03');

const initialM = [...search.expenseSearchSuggestions('M', names)];
assert.deepEqual(initialM.filter(item => item.kind === 'payer').map(item => item.value), ['adri', 'mel']);
assert.equal(search.hasExpenseSearch({ query: '   ' }), false);
assert.equal(search.hasExpenseSearch({ query: '', payer: 'mel' }), true);
const suggestions = [...search.expenseSearchSuggestions('Mel Supermercado noviembre 2026', names)];
let criteria = { query: 'Mel Supermercado noviembre 2026' };
for (const kind of ['payer', 'category', 'date']) {
  const suggestion = suggestions.find(item => item.kind === kind && (kind !== 'category' || item.value === 'supermercado'));
  assert.ok(suggestion, `Missing ${kind} suggestion`);
  criteria = search.applySearchSuggestion(criteria, suggestion);
}
assert.equal(criteria.query, ''); assert.equal(criteria.payer, 'mel'); assert.equal(criteria.category, 'supermercado');
assert.equal(criteria.date.month, 11); assert.equal(criteria.date.year, 2026);
assert.deepEqual(ids(criteria), ['partner-shared']);
assert.equal(search.searchDateLabel({ kind: 'month', month: 11 }).includes('todos los años'), true);
assert.equal(search.expenseSearchSuggestions('noviembre 0000', names).some(item => item.kind === 'date'), false);

// Signing in as Mel reverses cloud-relative IDs. A name must not bind to a fixed ID.
const reversed = { adri: 'Mel', mel: 'Marcelo' };
assert.deepEqual([...search.expenseSearchSuggestions('Marcelo', reversed)].filter(item => item.kind === 'payer').map(item => item.value), ['mel']);
assert.deepEqual([...search.expenseSearchSuggestions('Mel', reversed)].filter(item => item.kind === 'payer').map(item => item.value), ['adri']);
const melDemo = search.buildExpenseSearchIndex(data, 'mel', names);
assert.equal(melDemo.some(item => item.activity.entry.id === 'own-private'), false);
assert.equal(melDemo.some(item => item.activity.entry.id === 'partner-private'), true);
assert.equal(melDemo.some(item => item.activity.entry.id === 'saving-own'), false);
for (const section of ['all', 'shared', 'personal']) {
  const searched = search.filterExpenseSearch(index, { query: 'noviembre' }).filter(item => section === 'all'
    || (item.kind === 'expense' ? item.entry.shared === (section === 'shared') : section === 'personal'));
  const allowed = new Set([...domain.getExpenseActivity(data, 'adri', section)].map(item => item.entry.id));
  assert.ok(searched.every(item => allowed.has(item.entry.id)), `Crossed section ${section}`);
}
assert.equal(JSON.stringify(data), before, 'Search changed stored data');
assert.equal(JSON.stringify(domain.getBalance(data, 'adri')), balanceBefore, 'Search changed the ARS balance');
assert.equal(JSON.stringify(domain.getBalance(data, 'adri', 'USD')), dollarsBefore, 'Search changed the USD balance');
console.log('Buscador: texto, tildes, nombres, sugerencias ambiguas y filtros combinados OK.');
console.log('Fechas: formatos argentinos/ISO, meses, años, límites inclusivos y bisiestos OK.');
console.log('Privacidad: ambas cuentas, ahorro personal y secciones respetadas; datos y balances intactos.');
