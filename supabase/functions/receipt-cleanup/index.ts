import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-cleanup-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: cors });
  try {
  const url = Deno.env.get('SUPABASE_URL')!;
  const adminKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, adminKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const scheduledSecret = Deno.env.get('RECEIPT_CLEANUP_SECRET');
  const scheduled = scheduledSecret && request.headers.get('x-cleanup-secret') === scheduledSecret;

  if (!scheduled) {
    const token = request.headers.get('authorization')?.replace(/^Bearer /i, '');
    if (!token) return Response.json({ error: 'unauthorized' }, { status: 401, headers: cors });
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return Response.json({ error: 'unauthorized' }, { status: 401, headers: cors });
  }

  const batch = await admin.rpc('duo_receipt_cleanup_batch');
  if (batch.error) return Response.json({ error: 'cleanup_unavailable' }, { status: 500, headers: cors });
  let failed = 0;
  for (const row of batch.data ?? []) {
    const removed = await admin.storage.from('duo-receipts').remove([row.object_path]);
    if (removed.error) {
      failed++;
      continue;
    }
    const finished = await admin.rpc('duo_receipt_cleanup_done', { p_id: row.id });
    if (finished.error) failed++;
  }
  return Response.json({ pending: failed > 0 }, { headers: cors });
  } catch {
    return Response.json({ error: 'cleanup_unavailable' }, { status: 500, headers: cors });
  }
});
