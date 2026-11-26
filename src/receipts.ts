import type { SupabaseClient } from '@supabase/supabase-js';
import { RECEIPT_BUCKET } from './receiptTypes';
import type { ExpenseReceipt, ReceiptFile } from './receiptTypes';

const columns = 'id,expense_id,file_name,mime_type,byte_size,object_path';

export function receiptError(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? '');
  if (/duo_receipt_conflict/.test(message)) return 'El comprobante cambió en otro dispositivo. Volvé a abrir el gasto antes de reemplazarlo.';
  if (/duo_receipt_forbidden|row.level.security|Unauthorized|403/.test(message)) return 'No tenés permiso para modificar este comprobante.';
  if (/duo_receipt_expired/.test(message)) return 'La carga venció. Volvé a elegir el archivo.';
  if (/PGRST20[25]|does not exist|schema cache|Bucket not found/.test(message)) return 'Falta activar los comprobantes en Supabase.';
  if (/^(Elegí|El archivo|El comprobante|No pudimos|Este navegador|Guardá|No hay una aplicación)/.test(message)) return message;
  return 'No se pudo completar la operación. Revisá tu conexión y volvé a intentar.';
}

export async function readReceipt(client: SupabaseClient, expenseId: string): Promise<ExpenseReceipt | null> {
  const { data, error } = await client.from('duo_expense_receipts').select(columns).eq('expense_id', expenseId).eq('state', 'active').maybeSingle();
  if (error) throw error;
  return data as ExpenseReceipt | null;
}

export async function receiptUrl(client: SupabaseClient, receipt: ExpenseReceipt) {
  const { data, error } = await client.storage.from(RECEIPT_BUCKET).createSignedUrl(receipt.object_path, 60);
  if (error) throw error;
  return data.signedUrl;
}

export async function cleanupReceipts(client: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await client.functions.invoke('receipt-cleanup', { body: {} });
    return !error && data?.pending === false;
  } catch { return false; }
}

export async function attachReceipt(client: SupabaseClient, expenseId: string, file: ReceiptFile, expected: ExpenseReceipt | null) {
  const reserved = await client.rpc('duo_reserve_receipt', {
    p_id: file.id, p_expense_id: expenseId, p_expected_id: expected?.id ?? null,
    p_name: file.name, p_mime: file.mimeType, p_size: file.bytes.length,
  });
  if (reserved.error) throw reserved.error;
  // An ArrayBuffer avoids the React Native Blob/FormData upload incompatibility.
  const body = new Uint8Array(file.bytes).buffer;
  const uploaded = await client.storage.from(RECEIPT_BUCKET).upload(reserved.data, body, {
    contentType: file.mimeType, cacheControl: '0', upsert: false,
  });
  const finished = await client.rpc('duo_finish_receipt', { p_id: file.id });
  if (finished.error) {
    // A lost response can follow a committed transaction. Read before reporting failure.
    const current = await readReceipt(client, expenseId).catch(() => null);
    if (current?.id !== file.id) throw uploaded.error ?? finished.error;
  }
  const receipt: ExpenseReceipt = { id: file.id, expense_id: expenseId, file_name: file.name,
    mime_type: file.mimeType, byte_size: file.bytes.length, object_path: reserved.data };
  const clean = await cleanupReceipts(client);
  return { receipt, clean };
}

export async function removeReceipt(client: SupabaseClient, receipt: ExpenseReceipt) {
  const result = await client.rpc('duo_remove_receipt', { p_id: receipt.id });
  if (result.error) throw result.error;
  return cleanupReceipts(client);
}

export async function expenseIdForRequest(client: SupabaseClient, requestKey: string) {
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error('Volvé a iniciar sesión.');
  const { data, error } = await client.from('duo_movements').select('id')
    .eq('owner_id', session.user.id).eq('request_key', requestKey).in('kind', ['expense', 'expense-usd']).single();
  if (error) throw error;
  return data.id as string;
}
