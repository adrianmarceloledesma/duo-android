import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SafeAreaModal } from './SafeAreaModal';
import { dailyPersonalInterest, parseAnnualPercent } from './savingsInterest';

const percent = (rate: number) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(rate);
const pesos = (amount: number) => `$ ${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(amount)}`;

export function PersonalInterestControl({ rate, balance, onSave, shared = false, cash = false }: { rate: number; balance: number; shared?: boolean; cash?: boolean; onSave: (annualPercent: number) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Rendimiento anual ${cash ? 'del disponible del mes' : 'del ahorro ' + (shared ? 'compartido' : 'personal')}: ${percent(rate)} por ciento. Editar tasa`}
      onPress={() => setOpen(true)} style={({ pressed }) => [s.rateButton, rate > 0 && s.rateActive, pressed && s.pressed]}>
      <Text style={s.rateText}>{percent(rate)}% anual</Text>
    </Pressable>
    {open && <InterestEditor rate={rate} balance={balance} shared={shared} cash={cash} onClose={() => setOpen(false)} onSave={async value => { await onSave(value); setOpen(false); }}/>} 
  </>;
}

function InterestEditor({ rate, balance, onSave, onClose, shared, cash }: {
  rate: number; balance: number; shared: boolean; cash: boolean; onSave: (value: number) => Promise<void>; onClose: () => void;
}) {
  const [input, setInput] = useState(String(rate).replace('.', ','));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);
  const parsed = parseAnnualPercent(input);
  async function submit() {
    if (working.current) return;
    if (parsed === null) { setError('Ingresá un porcentaje anual entre 0 y 1000, con hasta cuatro decimales.'); return; }
    working.current = true; setBusy(true); setError('');
    try { await onSave(parsed); }
    catch (reason) {
      setError(reason instanceof Error && reason.message.startsWith('Falta activar') ? reason.message
        : 'No pudimos guardar la tasa. Revisá la conexión y volvé a intentar.');
    } finally { working.current = false; setBusy(false); }
  }
  function close() { if (!working.current) onClose(); }
  return <SafeAreaModal visible presentationStyle="fullScreen" animationType="slide" onRequestClose={close}>
    <SafeAreaView style={s.screen}>
      <View style={s.header}><Text accessibilityRole="header" style={s.heading}>{cash ? 'Rendimiento del disponible' : 'Rendimiento del ahorro'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Cerrar rendimiento" disabled={busy} onPress={close} style={s.close}><Text style={s.closeText}>×</Text></Pressable></View>
      <KeyboardAwareScrollView bottomOffset={20} keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
        <Text style={s.label}>Porcentaje anual</Text>
        <View style={s.inputRow}><TextInput accessibilityLabel="Porcentaje anual" value={input} onChangeText={value => {
          if (/^\d{0,4}(?:[.,]\d{0,4})?$/.test(value)) { setInput(value); setError(''); }
        }} editable={!busy} keyboardType="decimal-pad" selectTextOnFocus autoFocus maxLength={9} style={s.input}/><Text style={s.symbol}>%</Text></View>
        <Text style={s.body}>Ingresá la tasa anual que muestra tu banco o billetera. Por ejemplo, 18,9.</Text>
        <View style={s.preview}>
          <Text style={s.body}>{cash ? 'Disponible de hoy en pesos' : `Ahorro ${shared ? 'compartido' : 'personal'} en pesos`}</Text><Text style={s.balance}>{pesos(balance)}</Text>
          <Text style={s.body}>{parsed === 0 ? 'Rendimientos desactivados' : `Primer rendimiento estimado: + ${pesos(dailyPersonalInterest(balance, parsed ?? 0))}`}</Text>
        </View>
        <Text style={s.body}>{cash ? 'Al cerrar cada día, Duo registra el rendimiento como un ingreso personal y lo suma al disponible de ese mes. Se calcula sobre los movimientos fechados hasta ese día.' : 'Al cerrar cada día, Duo suma el rendimiento calculado al ahorro. Los siguientes cálculos incluyen lo que ya ganaste.'}</Text>
        <Text style={s.body}>Empieza desde hoy. El primer registro aparece al comenzar el día siguiente. Podés poner 0% para pausar los próximos rendimientos.</Text>
        <Text style={s.body}>Son importes calculados con la tasa que ingreses; pueden diferir de lo que acredita tu banco o billetera.</Text>
        {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      </KeyboardAwareScrollView>
      <View style={s.footer}><Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
        onPress={() => void submit()} style={[s.save, busy && s.pressed]}><Text style={s.saveText}>{busy ? 'Guardando…' : 'Guardar tasa'}</Text></Pressable></View>
    </SafeAreaView>
  </SafeAreaModal>;
}

const s = StyleSheet.create({
  rateButton: { minHeight: 44, paddingHorizontal: 12, borderRadius: 12, justifyContent: 'center', backgroundColor: '#eaf0e8', borderWidth: 1, borderColor: '#d2dfd2' },
  rateActive: { backgroundColor: '#d4e7a3', borderColor: '#b9ce89' }, rateText: { fontSize: 15, fontWeight: '700', color: '#21463b' }, pressed: { opacity: .6 },
  screen: { flex: 1, backgroundColor: '#fffefa' }, header: { padding: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: '#e8e7e0' },
  heading: { flex: 1, color: '#26342f', fontSize: 23, fontWeight: '700' }, close: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' }, closeText: { fontSize: 36, color: '#26342f' },
  content: { padding: 20, gap: 18 }, label: { color: '#26342f', fontWeight: '700', fontSize: 19 }, inputRow: { minHeight: 64, borderWidth: 1, borderColor: '#d2dfd2', borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, backgroundColor: '#f5f4ef' },
  input: { flex: 1, minWidth: 0, fontSize: 30, color: '#21463b', paddingVertical: 12, fontWeight: '600' }, symbol: { fontSize: 25, color: '#64776c' },
  body: { fontSize: 16, lineHeight: 24, color: '#526158' }, preview: { padding: 18, gap: 10, backgroundColor: '#eaf0e8', borderRadius: 16 }, balance: { fontSize: 30, fontWeight: '700', color: '#21463b' },
  error: { fontSize: 16, lineHeight: 24, color: '#9e342c' }, footer: { padding: 16, borderTopWidth: 1, borderColor: '#e8e7e0' }, save: { minHeight: 52, borderRadius: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: '#21463b' }, saveText: { fontSize: 18, color: '#fffefa', fontWeight: '700' },
});
