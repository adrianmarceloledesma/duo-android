import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function load(relative, imports = {}) {
  const source = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInNewContext(outputText, { exports, Date, Map, Set, process: { env: {} }, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected dependency: ${name}`);
    return imports[name];
  } });
  return exports;
}
const domain = await load('src/domain.ts');
const base = { amount: 100, category: 'supermercado', description: '', paidBy: 'adri', shared: true };
const data = { expenses: [
  { ...base, id: 'first', date: '2026-11-18', createdAt: '2026-11-18T20:00:00.000Z' },
  { ...base, id: 'latest-backdated', date: '2026-10-01', createdAt: '2026-11-18T20:05:00.000Z' },
  { ...base, id: 'middle', date: '2026-11-18', createdAt: '2026-11-18T20:03:00.000Z' },
], savings: [], incomes: [], transfers: [] };
const snapshot = JSON.stringify(data);
assert.deepEqual([...domain.getExpenseActivity(data, 'adri', 'all')].map(item => item.entry.id), ['latest-backdated', 'middle', 'first'], 'A newly added backdated expense must appear first');
const edited = { ...data, expenses: data.expenses.map(item => item.id === 'first' ? { ...item, date: '2027-01-01', amount: 200 } : item) };
assert.deepEqual([...domain.getExpenseActivity(edited, 'adri', 'all')].map(item => item.entry.id), ['latest-backdated', 'middle', 'first'], 'Editing must not change insertion order');
assert.equal(JSON.stringify(data), snapshot);
const stamp = Date.parse('2026-11-18T20:06:00Z');
const oldKey = `${stamp}-abc12-${stamp}-def34`;
assert.equal(domain.recordedAtFromKey(oldKey), '2026-11-18T20:06:00.000Z');
assert.equal(domain.recordedAtFromKey('not-a-timestamp'), undefined);
assert.equal(domain.recordedAtFromKey('9999999999999-abc'), undefined);
const oldExpense = { ...base, id: oldKey, date: '2020-01-01' };
assert.equal([...domain.getExpenseActivity({ ...data, expenses: [...data.expenses, oldExpense] }, 'adri', 'all')][0].entry.id, oldKey);
const withSavings = { ...data, savings: [{ id: 'saving', date: '2026-09-01', createdAt: '2026-11-18T20:10:00Z', amount: 20, currency: 'ARS', account: 'personal', owner: 'adri', kind: 'deposit', note: '' }] };
assert.equal([...domain.getExpenseActivity(withSavings, 'adri', 'all')][0].entry.id, 'saving');
assert.equal([...domain.getExpenseActivity(withSavings, 'adri', 'shared')].some(item => item.entry.id === 'saving'), false);
const microseconds = [{ id: 'earlier', date: '2026-11-18', createdAt: '2026-11-18T20:00:00.123400+00:00' }, { id: 'later', date: '2026-11-18', createdAt: '2026-11-18T20:00:00.123900+00:00' }];
assert.deepEqual(microseconds.sort(domain.compareAddedTime).map(item => item.id), ['later', 'earlier']);
const cloud = await load('src/cloud.ts', {
  'react-native-url-polyfill/auto': {}, '@react-native-async-storage/async-storage': { default: {} },
  '@supabase/supabase-js': { createClient: () => null }, './domain': domain,
});
const selections = [];
function fakeClient(missingCreatedAt) {
  return { from() {
    let columns;
    const query = { select(value) { columns = value; selections.push(value); return query; }, order() { return query; }, limit() { return query; }, gt() { return query; },
      then(resolve, reject) {
        const result = missingCreatedAt && columns.includes('created_at')
          ? { error: { code: '42703', message: 'column duo_movements.created_at does not exist' }, data: null }
          : { error: null, data: [{ id: 'cloud-expense', owner_id: 'owner', pair_id: null, recipient_id: null, request_key: oldKey,
            movement_date: '2020-01-01', kind: 'expense', amount: 100, currency: 'ARS', category: 'supermercado', note: '', saving_kind: null,
            ...(missingCreatedAt ? {} : { created_at: '2026-11-18T20:09:00+00:00' }) }] };
        return Promise.resolve(result).then(resolve, reject);
      },
    }; return query;
  } };
}
let saved = await cloud.readMovements(fakeClient(false), 'owner');
assert.equal(saved.expenses[0].createdAt, '2026-11-18T20:09:00+00:00', 'Server timestamp must take precedence');
saved = await cloud.readMovements(fakeClient(true), 'owner');
assert.equal(saved.expenses[0].createdAt, '2026-11-18T20:06:00.000Z');
assert.equal(saved.expenses[0].date, '2020-01-01', 'Original financial date changed');
assert.ok(selections.some(value => value.includes('request_key') && !value.includes('created_at')));
console.log('Orden: altas nuevas primero, gastos retroactivos, edición estable, ahorro personal, precisión y compatibilidad con Supabase OK.');
