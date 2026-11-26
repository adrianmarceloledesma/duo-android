import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SafeAreaModal } from './SafeAreaModal';
import { downloadReceipt, pickReceipt, releaseReceipt, viewReceiptPdf } from './receiptFiles';
import { attachReceipt, readReceipt, receiptError, receiptUrl, removeReceipt } from './receipts';
import type { ExpenseReceipt, ReceiptFile } from './receiptTypes';

type Props = {
  client: SupabaseClient | null;
  expenseId?: string;
  editable: boolean;
  disabled?: boolean;
  draft?: ReceiptFile | null;
  onDraft?: (file: ReceiptFile | null) => void;
  onBusy: (busy: boolean) => void;
};

export function ExpenseReceiptSection({ client, expenseId, editable, disabled, draft, onDraft, onBusy }: Props) {
  const [receipt, setReceipt] = useState<ExpenseReceipt | null>(null);
  const [loading, setLoading] = useState(!!expenseId && !!client);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(!expenseId);
  const [preview, setPreview] = useState<{ uri: string; name: string; pdf: boolean } | null>(null);
  const [imageScale, setImageScale] = useState(1);
  const [imageRatio, setImageRatio] = useState(1.5);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const operation = useRef(false);
  const mounted = useRef(true);
  const disabledAll = disabled || busy || loading;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    if (!expenseId || !client) return;
    setLoading(true);
    readReceipt(client, expenseId).then(value => {
      if (current) { setReceipt(value); setLoaded(true); setError(''); }
    }).catch(reason => { if (current) setError(receiptError(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, expenseId, attempt]);

  async function run(action: () => Promise<void>) {
    if (operation.current || disabled) return;
    operation.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    try { await action(); }
    catch (reason) { setError(receiptError(reason)); }
    finally { operation.current = false; setBusy(false); onBusy(false); }
  }

  async function choose() {
    await run(async () => {
      const file = await pickReceipt();
      if (!file) return;
      if (!mounted.current) { releaseReceipt(file); return; }
      if (expenseId && client) {
        try {
          const saved = await attachReceipt(client, expenseId, file, receipt);
          setReceipt(saved.receipt);
        } finally { releaseReceipt(file); }
      } else { onDraft?.(file); }
    });
  }

  async function view() {
    await run(async () => {
      setImageScale(1);
      setImageRatio(1.5);
      if (receipt && client) {
        const uri = await receiptUrl(client, receipt);
        setPreview({ uri, name: receipt.file_name, pdf: receipt.mime_type === 'application/pdf' });
      } else if (draft) setPreview({ uri: draft.uri, name: draft.name, pdf: draft.mimeType === 'application/pdf' });
    });
  }

  const name = receipt?.file_name ?? draft?.name;
  const bytes = receipt?.byte_size ?? draft?.bytes.length;
  const button = (label: string, onPress: () => void, destructive = false) =>
    <Pressable accessibilityRole="button" disabled={disabledAll} onPress={onPress}
      style={({ pressed }) => [s.button, destructive && s.dangerButton, (pressed || disabledAll) && s.dim]}>
      <Text style={[s.buttonText, destructive && s.danger]}>{label}</Text>
    </Pressable>;

  return <View style={s.section}>
    <Text style={s.title}>Comprobante <Text style={s.optional}>(opcional)</Text></Text>
    {loading ? <ActivityIndicator color="#21483d" accessibilityLabel="Cargando comprobante"/> : name ? <>
      <View style={s.file}><Text style={s.fileName}>{name}</Text>
        <Text style={s.hint}>{Math.max(1, Math.round((bytes ?? 0) / 1024))} KB</Text></View>
      <View style={s.actions}>
        {button('Ver comprobante', () => void view())}
        {receipt && client && button('Descargar', () => void run(async () => {
          await downloadReceipt(await receiptUrl(client, receipt), receipt);
        }))}
        {editable && button('Reemplazar', () => void choose())}
        {editable && button('Eliminar comprobante', () => setConfirmRemove(true), true)}
      </View>
    </> : loaded && <>
      {editable && button('Adjuntar archivo', () => void choose())}
      <Text style={s.hint}>{client ? 'JPG, PNG, WebP o PDF · Hasta 5 MB' : 'Iniciá sesión para adjuntar un comprobante.'}</Text>
    </>}
    {!!error && <View accessibilityLiveRegion="polite"><Text style={s.error}>{error}</Text>
      {!loaded && button('Volver a intentar', () => setAttempt(value => value + 1))}</View>}
    {busy && <View style={s.progress}><ActivityIndicator color="#21483d"/><Text style={s.hint}>Preparando comprobante…</Text></View>}
    {confirmRemove && <View style={s.confirm}>
      <Text style={s.fileName}>¿Eliminar el comprobante?</Text><Text style={s.hint}>El gasto se conserva.</Text>
      <View style={s.actions}>{button('Conservar', () => setConfirmRemove(false))}
        {button('Sí, eliminar', () => void run(async () => {
          if (receipt && client) { await removeReceipt(client, receipt); setReceipt(null); }
          else onDraft?.(null);
          setConfirmRemove(false);
        }), true)}</View>
    </View>}
    {!!preview && <SafeAreaModal visible presentationStyle="fullScreen" animationType="slide" onRequestClose={() => setPreview(null)}>
      <SafeAreaView style={s.preview}>
        <View style={s.previewHeader}><Text style={s.fileName}>Comprobante</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Cerrar comprobante" onPress={() => setPreview(null)} style={s.close}>
            <Text style={s.closeText}>×</Text></Pressable></View>
        <Text style={s.previewName}>{preview.name}</Text>
        {preview.pdf ? <View style={s.pdf}>
          <Text style={s.fileName}>Documento PDF</Text>
          {button('Abrir PDF', () => void run(async () => { await viewReceiptPdf(preview.uri); }))}
          {draft?.mimeType === 'application/pdf' && !receipt && <Text style={s.hint}>En Android, podés abrirlo después de guardar el gasto.</Text>}
        </View> : <>
          <View style={s.zoom}>{button(imageScale === 1 ? 'Agrandar imagen' : 'Reducir imagen', () => setImageScale(value => value === 1 ? 2.5 : 1))}</View>
          <ScrollView horizontal contentContainerStyle={s.imageContent}>
            <ScrollView style={{ width: windowWidth * imageScale }} contentContainerStyle={s.imageContent}>
              <Image accessibilityLabel="Imagen del comprobante" source={{ uri: preview.uri }} resizeMode="contain"
                style={{ width: windowWidth * imageScale, height: Math.max(windowHeight - 230, windowWidth * imageRatio) * imageScale }}
                onLoad={event => {
                  const { width, height } = event.nativeEvent.source;
                  if (width > 0 && height > 0) setImageRatio(height / width);
                }}
                onError={() => { setPreview(null); setError('No pudimos abrir la imagen. Volvé a intentar.'); }}/>
            </ScrollView>
          </ScrollView>
        </>}
      </SafeAreaView>
    </SafeAreaModal>}
  </View>;
}

const s = StyleSheet.create({
  section: { gap: 14, borderWidth: 1, borderColor: '#dedfd7', borderRadius: 18, padding: 18, backgroundColor: '#fffefa' },
  title: { fontSize: 18, fontWeight: '700', color: '#273930' },
  optional: { fontWeight: '400', color: '#69776f' },
  file: { gap: 6 }, fileName: { color: '#273930', fontSize: 17, fontWeight: '600', flexShrink: 1 },
  hint: { fontSize: 14, color: '#69776f', lineHeight: 21 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { backgroundColor: '#eaf1ed', borderRadius: 12, paddingVertical: 13, paddingHorizontal: 14, minHeight: 48, justifyContent: 'center' },
  buttonText: { color: '#21483d', fontWeight: '600', fontSize: 16, textAlign: 'center' },
  dangerButton: { backgroundColor: '#fbecea' }, danger: { color: '#9e342c' },
  dim: { opacity: 0.5 }, error: { color: '#9e342c', fontSize: 15, lineHeight: 22, marginBottom: 10 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  confirm: { padding: 14, borderRadius: 12, gap: 12, backgroundColor: '#fbf2ec' },
  preview: { flex: 1, backgroundColor: '#f6f5ef' },
  previewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  close: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' }, closeText: { fontSize: 36, color: '#273930' },
  previewName: { color: '#69776f', fontSize: 15, paddingHorizontal: 20, paddingBottom: 14 },
  imageContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  zoom: { paddingHorizontal: 20, paddingBottom: 12, alignItems: 'flex-start' },
  pdf: { padding: 24, gap: 20 },
});
