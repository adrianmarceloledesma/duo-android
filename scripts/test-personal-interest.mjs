import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
async function load(file, imports = {}) {
  const { outputText } = ts.transpileModule(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInNewContext(outputText, { exports, Date, Intl, Map, Set, require(name) {
    if (!(name in imports)) throw new Error(`Unexpected dependency: ${name}`);
    return imports[name];
  } });
  return exports;
}
const interest = await load('src/savingsInterest.ts');
const domain = await load('src/domain.ts');
assert.equal(interest.parseAnnualPercent('18,9'), 18.9);
assert.equal(interest.parseAnnualPercent('18.9'), 18.9);
assert.equal(interest.parseAnnualPercent('0'), 0);
for (const value of ['', '-1', '1001', '18.12345', '18,9.1', 'Infinity']) assert.equal(interest.parseAnnualPercent(value), null);
assert.equal(interest.dailyPersonalInterest(200000, 18.9), 103.56);
assert.equal(interest.dailyPersonalInterest(200103.56, 18.9), 103.62);
assert.equal(interest.dailyPersonalInterest(-200000, 18.9), 0);
assert.equal(interest.dailyPersonalInterest(200000, 0), 0);
assert.equal(interest.interestBusinessDay(new Date('2026-11-20T02:59:59Z')), '2026-11-19');
assert.equal(interest.interestBusinessDay(new Date('2026-11-20T03:00:00Z')), '2026-11-20');
assert.equal(interest.shiftInterestDay('2028-03-01', -1), '2028-02-29');
const data = { expenses: [], incomes: [], transfers: [], savings: [
  { id: 'seed', owner: 'adri', account: 'personal', currency: 'ARS', amount: 200000, kind: 'deposit', date: '2026-11-19', note: '', excludeFromMonthlyCash: true },
  { id: 'other-owner', owner: 'mel', account: 'personal', currency: 'ARS', amount: 60000, kind: 'deposit', date: '2026-11-19', note: '', excludeFromMonthlyCash: true },
  { id: 'dollars', owner: 'adri', account: 'personal', currency: 'USD', amount: 200, kind: 'deposit', date: '2026-11-19', note: '' },
  { id: 'shared', owner: 'adri', account: 'shared', currency: 'ARS', amount: 100000, kind: 'deposit', date: '2026-11-19', note: '', excludeFromMonthlyCash: true },
] };
const before = JSON.stringify(data);
const cashBefore = domain.getMonthlyCash(data, 'adri', '2026-11').remaining;
let next = interest.changeDemoInterest(data, 'adri', 18.9, '2026-11-19');
assert.equal(next.savings.length, data.savings.length, 'Activation credited past/unclosed days');
next = interest.settleDemoInterest(next, 'adri', '2026-11-20');
assert.equal(next.savings.at(-1).amount, 103.56);
assert.equal(next.savings.at(-1).interestOn, '2026-11-19');
assert.equal(interest.settleDemoInterest(next, 'adri', '2026-11-20'), next, 'Repeated refresh changed the ledger');
next = interest.settleDemoInterest(next, 'adri', '2026-11-21');
assert.equal(next.savings.at(-1).amount, 103.62);
assert.ok(Math.abs(domain.getSavingsBalance(next, 'personal', 'adri', 'ARS') - 200207.18) < .000001);
assert.equal(domain.getSavingsBalance(next, 'shared', 'adri', 'ARS'), 100000);
assert.equal(domain.getSavingsBalance(next, 'personal', 'adri', 'USD'), 200);
assert.equal(domain.getSavingsBalance(next, 'personal', 'mel', 'ARS'), 60000);
assert.equal(domain.getMonthlyCash(next, 'adri', '2026-11').remaining, cashBefore);
assert.equal(domain.getExpenseActivity(next, 'adri', 'all').some(item => item.entry.interestOn), false);
const rateChanged = interest.changeDemoInterest(next, 'adri', 36.5, '2026-11-21');
let tomorrow = interest.settleDemoInterest(rateChanged, 'adri', '2026-11-22');
assert.equal(tomorrow.savings.at(-1).amount, 200.21);
let paused = interest.changeDemoInterest(tomorrow, 'adri', 0, '2026-11-22');
paused = interest.settleDemoInterest(paused, 'adri', '2026-12-01');
assert.equal(paused.savings.length, tomorrow.savings.length, 'Paused rate credited interest');
const restarted = interest.changeDemoInterest(paused, 'adri', 18.9, '2026-12-01');
assert.equal(restarted.personalInterest.adri.settledThrough, '2026-11-30');
const withWithdrawal = { ...next, savings: [...next.savings, { id: 'withdrawal', owner: 'adri', account: 'personal', currency: 'ARS', amount: 100000, kind: 'withdraw', date: '2026-11-21', note: '' }] };
assert.equal(interest.settleDemoInterest(withWithdrawal, 'adri', '2026-11-22').savings.at(-1).amount, 51.89);
const removed = { ...next, savings: next.savings.filter(item => item.interestOn !== '2026-11-19') };
assert.equal(interest.settleDemoInterest(removed, 'adri', '2026-11-21'), removed, 'Deleted credit was recreated');
const catchup = interest.settleDemoInterest(interest.changeDemoInterest(data, 'adri', 18.9, '2026-11-19'), 'adri', '2026-11-22');
assert.deepEqual([...catchup.savings.filter(item => item.interestOn)].map(item => item.amount), [103.56, 103.62, 103.67]);
assert.equal(JSON.stringify(data), before, 'Source data mutated');
assert.equal(await interest.readPersonalInterest({ rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }), null);
assert.equal(await interest.readPersonalInterest({ rpc: async () => ({ data: null, error: { code: 'P0001', message: 'duo_profile_required' } }) }), null, 'New account onboarding was blocked');
await assert.rejects(interest.savePersonalInterest({ rpc: async () => ({ error: { code: 'PGRST202' } }) }, 18.9), /Falta activar/);
console.log('Rendimientos personales: tasa anual, capitalización, pausa/reinicio, retiros, edición/borrado, recuperación, zona horaria y aislamiento financiero OK.');

let shared = interest.changeDemoSharedInterest(data, 18.9, '2026-11-19');
assert.equal(shared.savings.length, data.savings.length);
shared = interest.settleDemoSharedInterest(shared, '2026-11-21');
assert.deepEqual([...shared.savings.filter(move => move.interestOn)].map(move => move.amount), [51.78, 51.81]);
assert.equal(interest.settleDemoSharedInterest(shared, '2026-11-21'), shared);
assert.ok(Math.abs(domain.getSavingsBalance(shared, 'shared', 'mel', 'ARS') - 100103.59) < .000001);
assert.equal(domain.getSavingsBalance(shared, 'personal', 'adri', 'ARS'), 200000);
assert.equal(domain.getMonthlyCash(shared, 'adri', '2026-11').remaining, cashBefore);
assert.equal(domain.getMonthlyCash(shared, 'mel', '2026-11').remaining, domain.getMonthlyCash(data, 'mel', '2026-11').remaining);
const both = interest.settleDemoInterest(interest.changeDemoInterest(shared, 'adri', 18.9, '2026-11-19'), 'adri', '2026-11-21');
assert.equal(both.savings.filter(move => move.interestOn).length, 4);
const pausedShared = interest.changeDemoSharedInterest(shared, 0, '2026-11-21');
assert.equal(interest.settleDemoSharedInterest(pausedShared, '2027-01-01').savings.length, shared.savings.length);
assert.equal(JSON.stringify(data), before);
assert.equal(await interest.readSharedInterest({ rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }), null);
await assert.rejects(interest.saveSharedInterest({ rpc: async () => ({ error: { code: 'PGRST202' } }) }, 18.9), /Falta activar/);
console.log('Rendimiento compartido: capitalización única, tasa independiente, pausa y aislamiento personal/mensual OK.');
