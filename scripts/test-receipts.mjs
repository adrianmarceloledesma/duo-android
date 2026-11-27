import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';

const root = fileURLToPath(new URL('../', import.meta.url));
function moduleFrom(source, imports = {}, globals = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInNewContext(output.outputText, { exports, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected import ${name}`);
    return imports[name];
  }, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, Blob, setTimeout, clearTimeout, ...globals });
  return exports;
}
const load = async (name, imports, globals) => moduleFrom(await readFile(path.join(root, name), 'utf8'), imports, globals);
const types = await load('src/receiptTypes.ts');
const jpg = new Uint8Array([255, 216, 255, ...new Array(197).fill(0)]);
const webp = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, ...new Array(88).fill(0)]);
assert.equal(types.receiptMime(jpg), 'image/jpeg');
assert.equal(types.receiptMime(webp), 'image/webp');
assert.equal(types.receiptMime(new TextEncoder().encode('%PDF-1.7')), 'application/pdf');
assert.equal(types.receiptMime(new Uint8Array([137,80,78,71,13,10,26,10])), 'image/png');
assert.throws(() => types.receiptMime(new TextEncoder().encode('<html>not an image')), /válido/);
assert.throws(() => types.validateReceiptSize(5242881), /5 MB/);
assert.throws(() => types.validateReceiptSize(0), /vacío/);
assert.equal(JSON.stringify(types.receiptDimensions(3200, 2400)), '{"width":1600,"height":1200}');
assert.equal(JSON.stringify(types.receiptDimensions(1200, 2400)), '{"width":800,"height":1600}');
assert.equal(JSON.stringify(types.receiptDimensions(300, 200)), '{"width":300,"height":200}');
assert.equal(types.receiptName('../Ticket\u0000.pdf').includes('/'), false);

// Browser preparation uses a controlled image codec. Native/browser packaging is checked separately.
let sourceBytes = jpg, compressedBytes = webp, dimensions = [3200, 2400], canvasSize, encoded = 0, cancelled = false;
const urls = new Set();
const filesWeb = await load('src/receiptFiles.web.ts', { './receiptTypes': types, 'expo-crypto': { randomUUID: () => 'file-id' } }, {
  Image: class { naturalWidth = dimensions[0]; naturalHeight = dimensions[1]; async decode() {} },
  URL: { createObjectURL: () => { const value = `blob:${urls.size}-${Math.random()}`; urls.add(value); return value; }, revokeObjectURL: url => urls.delete(url) },
  document: { createElement: type => type === 'input' ? {
    files: [{ name: 'Ticket.jpg', get size() { return sourceBytes.length; }, arrayBuffer: async () => sourceBytes.buffer }],
    addEventListener(event, callback) { this[event] = callback; }, click() { queueMicrotask(() => cancelled ? this.cancel() : this.change()); },
  } : {
    getContext: () => ({ drawImage(_image, _x, _y, width, height) { canvasSize = [width, height]; } }),
    toBlob(callback, format, quality) { assert.equal(format, 'image/webp'); assert.equal(quality, .78); encoded++; callback(new Blob([compressedBytes])); },
  } },
});
let prepared = await filesWeb.pickReceipt();
assert.equal(prepared.mimeType, 'image/webp'); assert.equal(prepared.name, 'Ticket.webp');
assert.deepEqual(canvasSize, [1600, 1200]); assert.equal(prepared.bytes.length, 100);
filesWeb.releaseReceipt(prepared); assert.equal(urls.size, 0);
dimensions = [400, 300]; compressedBytes = new Uint8Array([...webp, ...new Array(200).fill(0)]);
prepared = await filesWeb.pickReceipt();
assert.equal(prepared.mimeType, 'image/jpeg'); assert.equal(prepared.bytes.length, jpg.length);
filesWeb.releaseReceipt(prepared);
sourceBytes = new TextEncoder().encode('%PDF-1.7 original');
const encodesBefore = encoded; prepared = await filesWeb.pickReceipt();
assert.equal(encoded, encodesBefore); assert.deepEqual([...prepared.bytes], [...sourceBytes]); filesWeb.releaseReceipt(prepared);
sourceBytes = new Uint8Array(5242881); await assert.rejects(filesWeb.pickReceipt(), /5 MB/);
sourceBytes = new TextEncoder().encode('<svg/>'); await assert.rejects(filesWeb.pickReceipt(), /válido/);
cancelled = true; assert.equal(await filesWeb.pickReceipt(), null); assert.equal(urls.size, 0);
console.log('Archivos: firmas, límite 5 MB, compresión, proporciones, archivo optimizado, PDF y cancelación OK.');

let nativeBytes = jpg, nativeOutput = webp, manipulations = 0, resizeAction, downloadedPath;
const temporaryNativeFiles = new Map();
class NativeFile {
  constructor(...parts) { this.uri = parts.join('/'); }
  get exists() { return temporaryNativeFiles.has(this.uri); }
  async bytes() { return temporaryNativeFiles.get(this.uri) ?? nativeBytes; }
  delete() { temporaryNativeFiles.delete(this.uri); }
  static async downloadFileAsync(_url, destination) { downloadedPath = destination.uri; return destination; }
}
const filesNative = await load('src/receiptFiles.ts', {
  './receiptTypes': types, 'expo-crypto': { randomUUID: () => 'random-id' },
  'react-native': { Image: { getSize: (_uri, done) => done(2400, 3200) }, Linking: { openURL: async () => {} }, Platform: { OS: 'android' } },
  'expo-document-picker': { getDocumentAsync: async () => ({ canceled: false, assets: [{ uri: 'cache/source', name: 'Ticket.jpg', size: nativeBytes.length }] }) },
  'expo-file-system': { File: NativeFile, Paths: { cache: 'safe-cache' } },
  'expo-file-system/legacy': { StorageAccessFramework: { requestDirectoryPermissionsAsync: async () => ({ granted: false }) }, EncodingType: { Base64: 'base64' } },
  'expo-image-manipulator': { SaveFormat: { WEBP: 'webp' }, manipulateAsync: async (_uri, actions, options) => {
    manipulations++; resizeAction = actions[0]; assert.equal(options.compress, .78);
    temporaryNativeFiles.set('cache/compressed', nativeOutput); return { uri: 'cache/compressed' };
  } },
  'expo-sharing': {},
});
prepared = await filesNative.pickReceipt();
assert.equal(resizeAction.resize.width, 1200); assert.equal(resizeAction.resize.height, 1600);
assert.equal(prepared.mimeType, 'image/webp'); assert.equal(prepared.bytes.length, 100);
filesNative.releaseReceipt(prepared); assert.equal(temporaryNativeFiles.size, 0);
nativeBytes = new TextEncoder().encode('%PDF-1.7 original'); const nativeCount = manipulations;
prepared = await filesNative.pickReceipt(); assert.equal(manipulations, nativeCount);
assert.equal(prepared.mimeType, 'application/pdf'); filesNative.releaseReceipt(prepared);
await filesNative.downloadReceipt('https://private-url', { mime_type: 'application/pdf', file_name: '../../untrusted.pdf' });
assert.equal(downloadedPath, 'safe-cache/random-id.pdf');
console.log('Android: preparación de imagen, PDF intacto y rutas de descarga seguras OK.');

const receiptApi = await load('src/receipts.ts', { './receiptTypes': types });
const calls = [];
let uploadError = null, finishError = null, cleanupError = null, failRead = false;
const row = { id: 'file-id', expense_id: 'expense-id', file_name: 'Ticket.jpg', mime_type: 'image/jpeg', byte_size: 200, object_path: 'owner/expense-id/file-id' };
const client = {
  rpc: async (name, args) => { calls.push([name, args]); return { data: row.object_path, error: name === 'duo_finish_receipt' ? finishError : null }; },
  storage: { from: () => ({ upload: async (key, body, options) => {
    calls.push(['upload', key, body, options]); return { error: uploadError };
  } }) },
  functions: { invoke: async () => ({ data: { pending: false }, error: cleanupError }) },
  from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: failRead ? null : row, error: failRead ? new Error('network') : null }) }; return q; },
};
const upload = { id: 'file-id', bytes: jpg, name: 'Ticket.jpg', mimeType: 'image/jpeg', uri: 'temp' };
let result = await receiptApi.attachReceipt(client, 'expense-id', upload, null);
assert.equal(result.receipt.id, 'file-id'); assert.equal(result.clean, true);
assert.deepEqual(calls.map(item => item[0]), ['duo_reserve_receipt', 'upload', 'duo_finish_receipt']);
assert.equal(calls[1][2].byteLength, jpg.length); assert.equal(calls[1][3].upsert, false);
calls.length = 0; uploadError = { statusCode: '409' }; finishError = new Error('response lost');
result = await receiptApi.attachReceipt(client, 'expense-id', upload, null); assert.equal(result.receipt.id, 'file-id');
uploadError = { statusCode: '400', message: 'Asset Already Exists' }; finishError = null;
result = await receiptApi.attachReceipt(client, 'expense-id', upload, null); assert.equal(result.receipt.id, 'file-id');
uploadError = null; finishError = new Error('response lost');
failRead = true; await assert.rejects(receiptApi.attachReceipt(client, 'expense-id', upload, null), /response lost/);
uploadError = new Error('offline'); finishError = new Error('duo_receipt_upload_missing'); calls.length = 0;
await assert.rejects(receiptApi.attachReceipt(client, 'expense-id', upload, null), /offline/);
assert.equal(calls.some(item => item[0] === 'duo_remove_receipt'), false, 'Upload failure removed an existing file');
cleanupError = new Error('offline'); assert.equal(await receiptApi.removeReceipt(client, row), false);
assert.equal(calls.at(-1)[0], 'duo_remove_receipt');
assert.equal(calls.some(item => /movement|expense_change/.test(item[0])), false);
console.log('Cliente: carga, reintentos, respuesta perdida y borrado independiente del gasto OK.');

let handler, removes = 0, marks = 0, authenticated = false, storageFailure = false;
const admin = {
  auth: { getUser: async () => ({ data: { user: authenticated ? { id: 'owner' } : null }, error: null }) },
  rpc: async name => { if (name === 'duo_receipt_cleanup_done') marks++; return { data: name === 'duo_receipt_cleanup_batch' ? [{ id: 'retired', object_path: 'old/path' }] : null, error: null }; },
  storage: { from: () => ({ remove: async paths => { assert.deepEqual([...paths], ['old/path']); removes++; return { error: storageFailure ? new Error('offline') : null }; } }) },
};
await load('supabase/functions/receipt-cleanup/index.ts', { 'npm:@supabase/supabase-js@2': { createClient: () => admin } }, {
  Request, Response, Deno: { serve: fn => { handler = fn; }, env: { get: key => ({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only', RECEIPT_CLEANUP_SECRET: 'cron-only' })[key] } },
});
let response = await handler(new Request('https://function', { method: 'POST' })); assert.equal(response.status, 401); assert.equal(removes, 0);
response = await handler(new Request('https://function', { method: 'POST', headers: { 'x-cleanup-secret': 'wrong' } })); assert.equal(response.status, 401);
response = await handler(new Request('https://function', { method: 'POST', headers: { 'x-cleanup-secret': 'cron-only' } })); assert.equal(response.status, 200); assert.equal(marks, 1);
authenticated = true; storageFailure = true;
response = await handler(new Request('https://function', { method: 'POST', headers: { authorization: 'Bearer valid-user' } }));
assert.equal((await response.json()).pending, true); assert.equal(marks, 1, 'Failed removal was marked clean');
console.log('Limpieza: autorización, eliminación por API y reintento ante fallos OK.');

const db = new PGlite();
try {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role supabase_auth_admin nologin;
    create role service_role nologin bypassrls;
    create schema auth; create schema extensions; create schema net; create schema storage;
    create table auth.users (id uuid primary key, email text unique);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb, unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated, anon, service_role;
    grant select, insert, update, delete on storage.objects to authenticated, anon, service_role;
    create table net.http_request_queue (id bigint generated always as identity, url text, headers jsonb, body bytea);
    create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
      headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 1000) returns bigint language plpgsql as $$
      declare id bigint; begin insert into net.http_request_queue(url,headers,body) values(url,headers,convert_to(body::text,'UTF8')) returning net.http_request_queue.id into id; return id; end $$;
  `);
  for (const name of (await readdir(path.join(root, 'supabase/migrations'))).sort()) {
    if (name === '20261118000400_duo_notification_details_and_entry_order.sql') {
      let reproduced = false;
      try { await db.exec(await readFile(path.join(root, 'supabase/tests/duo_notification_descriptions.sql'), 'utf8')); }
      catch (error) {
        if (error.code !== 'P0004') throw error;
        reproduced = true;
        await db.exec('rollback;');
      }
      assert.equal(reproduced, true, 'The previous trigger unexpectedly passed the amount/category regression');
      console.log('Regresión reproducida: el aviso anterior no incluía monto y categoría.');
    }
    const sql = (await readFile(path.join(root, 'supabase/migrations', name), 'utf8')).replace(/create extension if not exists pg_net with schema extensions;/g, '');
    await db.exec(sql);
    if (name === '20261119000100_duo_personal_savings_interest.sql' || name === '20261119000200_duo_shared_savings_interest.sql' || name === '20261123000200_duo_monthly_cash_interest.sql' || name === '20261126000100_duo_public_google_registration.sql') await db.exec(sql);
  }
  for (const name of (await readdir(path.join(root, 'supabase/tests'))).filter(name => name.endsWith('.sql')).sort()) {
    try { await db.exec(await readFile(path.join(root, 'supabase/tests', name), 'utf8')); }
    catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
    console.log(`PostgreSQL: ${name} OK`);
  }
} finally { await db.close(); }
