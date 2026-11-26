import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  ActivityIndicator, AppState, Image, Linking, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { addCloudMovement, changeCloudExpense, changeCloudMovement, cloudClient, cloudError, readDueDates, readMovements, readPartner, readProfile, writeDueDate } from './cloud';
import type { CloudDashboard, Profile } from './cloud';
import { readCashInterest, saveCashInterest } from './cashInterest';
import { readPersonalInterest, savePersonalInterest, readSharedInterest, saveSharedInterest } from './savingsInterest';
import type { PersonalInterestStatus } from './savingsInterest';
import { reviseMovement } from './domain';
import type { DuoData } from './domain';
import { completeGoogleSignIn, signInWithGoogle } from './googleAuth';
import { showTestNotification, useDuoNotifications } from './notifications';
import { useDuoUpdates } from './useDuoUpdates';
import type { NotificationPreference } from './notifications';
import { SafeAreaModal } from './SafeAreaModal';

type Dashboard = ComponentType<{ cloud?: CloudDashboard; onExitDemo?: () => void }>;
type AccountPage = 'profile' | 'notifications';

export function AccountEntry({ Dashboard }: { Dashboard: Dashboard }) {
  const [demo, setDemo] = useState(false);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [initialSignInError, setInitialSignInError] = useState('');
  const checkedInitialLink = useRef(false);

  useEffect(() => {
    if (!cloudClient) return;
    const client = cloudClient;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => setSession(next));
    const updateRefresh = (state: string) => {
      if (state === 'active') void client.auth.startAutoRefresh();
      else void client.auth.stopAutoRefresh();
    };
    updateRefresh(AppState.currentState ?? 'active');
    const appState = AppState.addEventListener('change', updateRefresh);
    return () => {
      subscription.unsubscribe();
      appState.remove();
      void client.auth.stopAutoRefresh();
    };
  }, []);

  useEffect(() => {
    if (session === undefined || checkedInitialLink.current) return;
    checkedInitialLink.current = true;
    if (!cloudClient || session) return;
    const client = cloudClient;
    void Linking.getInitialURL().then(url => {
      if (url) return completeGoogleSignIn(client, url);
    }).catch(error => {
      setInitialSignInError(cloudError(error, 'Volvé a intentar el acceso con Google.'));
    });
  }, [session]);

  if (demo) return <Dashboard onExitDemo={() => setDemo(false)}/>;
  if (!cloudClient) return <AccountScreen title="Probá Duo" body="El acceso con correo y contraseña estará disponible cuando se conecte Supabase.">
    <AccountButton title="Abrir demo" onPress={() => setDemo(true)}/>
  </AccountScreen>;
  if (session === undefined) return <AccountScreen title="Abriendo Duo"><ActivityIndicator color={palette.ink}/></AccountScreen>;
  if (!session) return <SignIn client={cloudClient} initialError={initialSignInError}
    onDemo={() => { setInitialSignInError(''); setDemo(true); }}/>;
  return <ConnectedAccount key={session.user.id} client={cloudClient} session={session} Dashboard={Dashboard}/>;
}

function useAccountAction() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<void>, fallback: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cloudError(cause, fallback));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

function SignIn({ client, initialError, onDemo }: { client: SupabaseClient; initialError: string; onDemo: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [attempted, setAttempted] = useState(false);
  const action = useAccountAction();

  function signIn() {
    if (!password) return;
    setAttempted(true);
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      action.setError('Ingresá un correo válido.');
      return;
    }
    void action.run(async () => {
      const { error } = await client.auth.signInWithPassword({ email: address, password });
      if (error) throw error;
      setPassword('');
    }, 'No pudimos iniciar sesión. Revisá la conexión y volvé a intentar.');
  }

  function continueWithGoogle() {
    setAttempted(true);
    void action.run(() => signInWithGoogle(client), 'No pudimos iniciar sesión con Google. Volvé a intentar.');
  }

  return <AccountScreen title="Entrá a Duo">
    <Pressable style={[styles.googleButton, action.busy && styles.disabled]} accessibilityRole="button"
      accessibilityState={{ disabled: action.busy }} disabled={action.busy} onPress={continueWithGoogle}>
      <Image source={require('../assets/google-sign-in.png')} style={styles.googleLogo} accessible={false}/>
      <Text style={styles.googleButtonText}>Continuar con Google</Text>
    </Pressable>
    <Text style={styles.label}>Correo electrónico</Text>
    <TextInput style={styles.input} accessibilityLabel="Correo electrónico" value={email} onChangeText={setEmail}
      autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email"
      editable={!action.busy} placeholder="nombre@correo.com" placeholderTextColor={palette.muted}/>
    <Text style={styles.label}>Contraseña</Text>
    <TextInput style={styles.input} accessibilityLabel="Contraseña" value={password} onChangeText={setPassword}
      secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password"
      editable={!action.busy} returnKeyType="go" onSubmitEditing={signIn}/>
    <ErrorText value={action.error || (attempted ? '' : initialError)}/>
    <AccountButton title={action.busy ? 'Entrando…' : 'Entrar'} onPress={signIn} disabled={action.busy || !email.trim() || !password}/>
    <AccountButton title="Abrir demo" onPress={onDemo} disabled={action.busy} secondary/>
  </AccountScreen>;
}

type Snapshot = {
  profile: Profile | null; partner: Profile | null; data: DuoData;
  personalInterest: PersonalInterestStatus | null;
  cashInterest: PersonalInterestStatus | null;
  sharedInterest: PersonalInterestStatus | null;
  dueDatePaymentsEnabled: boolean; dueDateRecurrenceEnabled: boolean;
};

async function signOut(client: SupabaseClient) {
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

function ConnectedAccount({ client, session, Dashboard }: { client: SupabaseClient; session: Session; Dashboard: Dashboard }) {
  const userId = session.user.id;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [syncError, setSyncError] = useState('');
  const [loading, setLoading] = useState(true);
  const [accountPage, setAccountPage] = useState<AccountPage | null>(null);
  const revision = useRef(0);
  const dueDateViewMonth = useRef<string | null>(null);
  const action = useAccountAction();
  const notifications = useDuoNotifications(client, userId, snapshot?.data.dueDates);
  const updates = useDuoUpdates();
  const dueDateNotificationsEnabled = notifications.preferences?.overdue === true || notifications.preferences?.reminders === true;

  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const today = new Date();
      const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      const reminderMonth = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;
      const viewMonth = dueDateViewMonth.current;
      const dueThroughMonth = dueDateNotificationsEnabled && (!viewMonth || reminderMonth > viewMonth) ? reminderMonth : viewMonth;
      const [personalInterest, sharedInterest, cashInterest] = await Promise.all([readPersonalInterest(client), readSharedInterest(client), readCashInterest(client)]);
      const [profile, partner, data, { dueDates, paymentsEnabled, recurrenceEnabled }] = await Promise.all([
        readProfile(client, userId), readPartner(client), readMovements(client, userId),
        readDueDates(client, userId, dueThroughMonth),
      ]);
      if (current !== revision.current) return;
      setSnapshot({
        profile, partner, data: { ...data, dueDates }, personalInterest, sharedInterest, cashInterest,
        dueDatePaymentsEnabled: paymentsEnabled, dueDateRecurrenceEnabled: recurrenceEnabled,
      });
      setSyncError('');
    } catch {
      if (current === revision.current) setSyncError('No pudimos actualizar tu cuenta. Revisá la conexión e intentá de nuevo.');
    } finally {
      if (current === revision.current) setLoading(false);
    }
  }, [client, dueDateNotificationsEnabled, userId]);

  const setDueDateViewMonth = useCallback((month: string | null) => {
    if (dueDateViewMonth.current === month) return;
    dueDateViewMonth.current = month;
    if (month) void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, 20000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh();
      else revision.current++;
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
      revision.current++;
    };
  }, [refresh]);

  const logout = async () => {
    await notifications.disconnect();
    await signOut(client);
  };
  if (loading) return <AccountScreen title="Abriendo tu cuenta"><ActivityIndicator color={palette.ink}/></AccountScreen>;
  if (!snapshot) return <AccountScreen title="No se pudo abrir tu cuenta" body={syncError}>
    <AccountButton title="Reintentar" onPress={() => { setLoading(true); void refresh(); }}/>
    <ErrorText value={action.error}/>
    <AccountButton title="Cerrar sesión" disabled={action.busy}
      onPress={() => void action.run(logout, 'No pudimos cerrar la sesión. Volvé a intentar.')} secondary/>
  </AccountScreen>;
  if (!snapshot.profile) return <CreateProfile client={client} userId={userId} refresh={refresh} syncError={syncError}/>;

  const { profile, partner, data, dueDatePaymentsEnabled, dueDateRecurrenceEnabled, personalInterest, sharedInterest, cashInterest } = snapshot;
  const cloud: CloudDashboard = {
    data,
    personalInterest,
    cashInterest,
    async setCashInterest(annualPercent) {
      await saveCashInterest(client, annualPercent);
      await refresh();
    },
    sharedInterest,
    async setSharedInterest(annualPercent) {
      await saveSharedInterest(client, annualPercent);
      await refresh();
    },
    async setPersonalInterest(annualPercent) {
      await savePersonalInterest(client, annualPercent);
      await refresh();
    },
    userId,
    names: { adri: profile.display_name, mel: partner?.display_name ?? 'Tu pareja' },
    linked: !!partner,
    dueDatePaymentsEnabled,
    dueDateRecurrenceEnabled,
    setDueDateViewMonth,
    syncError,
    refresh,
    async write(change, requestKey) {
      if (change.kind === 'edit-expense' || change.kind === 'delete-expense') {
        await changeCloudExpense(client, change);
        revision.current++;
        setSnapshot(current => {
          if (!current) return current;
          const expenses = change.kind === 'delete-expense'
            ? current.data.expenses.filter(expense => expense.id !== change.id)
            : current.data.expenses.map(expense => expense.id === change.id ? { ...expense, ...change.entry } : expense);
          return { ...current, data: { ...current.data, expenses } };
        });
      } else if (change.kind === 'edit-movement' || change.kind === 'delete-movement') {
        await changeCloudMovement(client, change);
        revision.current++;
        setSnapshot(current => current && {
          ...current, data: reviseMovement(current.data, change.movement, change.kind === 'delete-movement'),
        });
      } else if (change.kind === 'due-date') {
        await writeDueDate(client, change, requestKey, dueDatePaymentsEnabled);
      } else {
        await addCloudMovement(client, change, requestKey);
      }
      await refresh();
    },
    openAccount: () => setAccountPage('profile'),
  };

  return <>
    <Dashboard cloud={cloud}/>
    {accountPage && <SafeAreaModal visible animationType="slide"
      onRequestClose={() => setAccountPage(page => page === 'notifications' ? 'profile' : null)}>
      <LinkAccount client={client} name={profile.display_name} partner={partner} refresh={refresh}
        email={session.user.email} syncError={syncError} onClose={() => setAccountPage(null)}
        page={accountPage} onPageChange={setAccountPage} notifications={notifications} updates={updates} onLogout={logout}/>
    </SafeAreaModal>}
    {updates.notice && <UpdateNotice kind={updates.notice} busy={updates.busy}
      onClose={updates.dismissNotice} onApply={() => void updates.apply()}/>}
  </>;
}

function CreateProfile({ client, userId, refresh, syncError }: {
  client: SupabaseClient; userId: string; refresh: () => Promise<void>; syncError: string;
}) {
  const [name, setName] = useState('');
  const action = useAccountAction();
  function save() {
    if (!name.trim()) return;
    void action.run(async () => {
      const { error } = await client.from('duo_profiles').upsert({ user_id: userId, display_name: name.trim() });
      if (error) throw error;
      await refresh();
    }, 'No pudimos guardar tu nombre. Volvé a intentar.');
  }
  return <AccountScreen title="¿Cómo te llamás?" body="Este nombre aparecerá en los movimientos que compartan.">
    <Text style={styles.label}>Tu nombre</Text>
    <TextInput style={styles.input} accessibilityLabel="Tu nombre" value={name} onChangeText={setName}
      editable={!action.busy} placeholder="Ej. Marce" placeholderTextColor={palette.muted} maxLength={60} onSubmitEditing={save}/>
    <ErrorText value={action.error || syncError}/>
    <AccountButton title="Continuar" onPress={save} disabled={action.busy || !name.trim()}/>
    <AccountButton title="Cerrar sesión" onPress={() => void action.run(() => signOut(client), 'No pudimos cerrar la sesión. Volvé a intentar.')}
      disabled={action.busy} secondary/>
  </AccountScreen>;
}

function LinkAccount({ client, name, email, partner, refresh, syncError, onClose, page, onPageChange, notifications, updates, onLogout }: {
  client: SupabaseClient; name: string; email?: string; partner: Profile | null;
  refresh: () => Promise<void>; syncError: string; onClose: () => void;
  page: AccountPage; onPageChange: (page: AccountPage) => void;
  notifications: ReturnType<typeof useDuoNotifications>; updates: ReturnType<typeof useDuoUpdates>; onLogout: () => Promise<void>;
}) {
  const [invite, setInvite] = useState('');
  const [received, setReceived] = useState('');
  const action = useAccountAction();
  const code = received.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i)?.[0];

  function generate() {
    void action.run(async () => {
      const { data, error } = await client.rpc('duo_create_invite');
      if (error) throw error;
      setInvite(data as string);
    }, 'No pudimos generar la invitación. Volvé a intentar.');
  }

  function accept() {
    if (!code) return;
    void action.run(async () => {
      const { error } = await client.rpc('duo_accept_invite', { invite_code: code });
      if (error) throw error;
      setReceived('');
      await refresh();
    }, 'No pudimos vincular las cuentas. Volvé a intentar.');
  }

  if (page === 'notifications') {
    return <NotificationSettings notifications={notifications} onBack={() => onPageChange('profile')}/>;
  }

  return <AccountScreen title={name} body={email} onClose={onClose}>
    <Text style={styles.label}>{partner ? `Cuenta vinculada con ${partner.display_name}` : 'Vincular otra cuenta'}</Text>
    {!partner && <>
      <AccountButton title="Generar invitación" onPress={generate} disabled={action.busy} secondary/>
      {!!invite && <>
        <Text selectable style={styles.inviteCode}>{invite}</Text>
        <Text style={styles.hint}>El código vence 24 horas después de generarse.</Text>
        <AccountButton title="Compartir código" disabled={action.busy}
          onPress={() => void action.run(async () => {
            await Share.share({ message: `Mi código para vincularnos en Duo: ${invite}` });
          }, 'No pudimos abrir el menú para compartir. Podés copiar el código.')} secondary/>
      </>}
      <Text style={styles.label}>¿Te enviaron un código?</Text>
      <TextInput style={styles.input} accessibilityLabel="Código de invitación" value={received} onChangeText={setReceived}
        autoCapitalize="none" autoCorrect={false} editable={!action.busy} placeholder="Pegá el código" placeholderTextColor={palette.muted}/>
      <AccountButton title="Vincular cuentas" onPress={accept} disabled={action.busy || !code}/>
    </>}
    <Pressable accessibilityRole="button" accessibilityLabel="Notificaciones"
      onPress={() => onPageChange('notifications')} disabled={action.busy}
      style={({ pressed }) => [styles.notificationLink, pressed && styles.settingPressed]}>
      <View style={styles.notificationBadge}>
        <Image source={require('../assets/notification-bell.png')} style={styles.notificationIcon}/>
      </View>
      <Text style={styles.notificationLabel}>Notificaciones</Text>
      <Text style={styles.notificationChevron}>›</Text>
    </Pressable>
    {updates.pending && <AccountButton title="Actualizar app"
      disabled={updates.busy || action.busy || notifications.busy} onPress={() => void updates.apply()}/>}
    {updates.version && <Text style={styles.version}>
      Versión {updates.version}{updates.updateDate ? ` · ${updates.updateDate}` : ''}
    </Text>}
    <ErrorText value={action.error || syncError}/>
    <AccountButton title="Cerrar sesión" onPress={() => void action.run(onLogout, 'No pudimos cerrar la sesión. Volvé a intentar.')}
      disabled={action.busy || notifications.busy} danger/>
  </AccountScreen>;
}

function UpdateNotice({ kind, busy, onClose, onApply }: {
  kind: 'available' | 'applied'; busy: boolean; onClose: () => void; onApply: () => void;
}) {
  const available = kind === 'available';
  return <SafeAreaModal visible transparent animationType="fade" onRequestClose={onClose}>
    <SafeAreaView style={styles.updateBackdrop}>
      <View style={styles.updateCard} accessibilityViewIsModal>
        <View style={styles.updateIcon} accessible={false}>
          <Text style={styles.updateGlyph} accessibilityElementsHidden importantForAccessibility="no">{
            available ? '↻' : '✓'
          }</Text>
        </View>
        <Text accessibilityRole="header" style={styles.updateTitle}>
          {available ? 'Actualización disponible' : 'Duo se actualizó'}
        </Text>
        {available && <Text style={styles.updateBody}>Duo se va a reiniciar al aplicar el cambio.</Text>}
        <View style={styles.updateActions}>
          {available && <View style={styles.updateAction}>
            <AccountButton title="Ahora no" onPress={onClose} secondary/>
          </View>}
          <View style={styles.updateAction}>
            <AccountButton title={available ? 'Actualizar' : 'Listo'} disabled={available && busy}
              onPress={available ? onApply : onClose}/>
          </View>
        </View>
      </View>
    </SafeAreaView>
  </SafeAreaModal>;
}

const notificationSections = [
  { title: 'Vencimientos', options: [
    ['reminders', 'Recordatorios'],
    ['overdue', 'Vencimientos atrasados'],
  ] },
  { title: 'Cuenta compartida', options: [
    ['sharedExpenses', 'Gastos compartidos'],
    ['debtPayments', 'Deudas y pagos'],
    ['showDescriptions', 'Mostrar detalle del movimiento'],
  ] },
] as const satisfies readonly { title: string; options: readonly (readonly [NotificationPreference, string])[] }[];

function NotificationSettings({ notifications, onBack }: {
  notifications: ReturnType<typeof useDuoNotifications>; onBack: () => void;
}) {
  const { preferences, busy, error, setPreference } = notifications;
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState('');
  const disabled = !preferences || busy || testing;

  async function testNotice() {
    setTesting(true);
    setTestMessage('');
    try {
      const sent = await showTestNotification();
      if (!sent) setTestMessage('Activá las notificaciones de Duo desde los ajustes de Android.');
    } catch {
      setTestMessage('No pudimos mostrar el aviso de prueba. Volvé a intentarlo.');
    } finally {
      setTesting(false);
    }
  }

  return <SafeAreaView style={styles.screen}>
    <StatusBar style="dark"/>
    <View style={styles.notificationHeader}>
      <Pressable accessibilityRole="button" accessibilityLabel="Volver al perfil" onPress={onBack}
        style={({ pressed }) => [styles.headerButton, pressed && styles.settingPressed]}>
        <Text style={styles.backGlyph}>‹</Text>
      </Pressable>
      <Text accessibilityRole="header" style={styles.notificationTitle}>Notificaciones</Text>
    </View>
    <ScrollView contentContainerStyle={styles.notificationContent}>
      <ErrorText value={error}/>
      {notificationSections.map(({ title, options }) => <View key={title} style={styles.notificationSection}>
        <Text accessibilityRole="header" style={styles.label}>{title}</Text>
        <View style={styles.notificationCard}>
          {options.map(([key, label], index) => {
            const checked = preferences?.[key] ?? false;
            return <Pressable key={key} accessibilityRole="switch" accessibilityLabel={label}
              accessibilityState={{ checked, disabled }} disabled={disabled}
              onPress={() => void setPreference(key, !checked)}
              style={({ pressed }) => [styles.notificationRow, index > 0 && styles.notificationDivider, pressed && styles.settingPressed]}>
              <Text style={styles.notificationLabel}>{label}</Text>
              <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Switch value={checked} accessible={false} trackColor={{ false: '#d2dbd3', true: '#a7c6a3' }}
                  thumbColor={checked ? palette.ink : palette.paper}/>
              </View>
            </Pressable>;
          })}
        </View>
      </View>)}
      <View style={styles.notificationSection}>
        <AccountButton title={testing ? 'Enviando…' : 'Probar aviso en este celular'} secondary disabled={disabled}
          onPress={() => void testNotice()}/>
        <ErrorText value={testMessage}/>
      </View>
    </ScrollView>
  </SafeAreaView>;
}

function ErrorText({ value }: { value: string }) {
  return value ? <Text accessibilityRole="alert" style={styles.error}>{value}</Text> : null;
}

function AccountButton({ title, onPress, disabled = false, secondary = false, danger = false }: {
  title: string; onPress: () => void; disabled?: boolean; secondary?: boolean; danger?: boolean;
}) {
  return <Pressable style={[styles.button, secondary && styles.secondary, danger && styles.signOutButton, disabled && styles.disabled]}
    accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{title}</Text>
  </Pressable>;
}

function AccountScreen({ title, body, children, onClose }: {
  title: string; body?: string; children: ReactNode; onClose?: () => void;
}) {
  return <SafeAreaView style={styles.screen}>
    <StatusBar style="dark"/>
      <KeyboardAwareScrollView bottomOffset={16} contentContainerStyle={styles.layout} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          {onClose && <Pressable accessibilityRole="button" accessibilityLabel="Volver a Duo" onPress={onClose}
            style={({ pressed }) => [styles.headerButton, styles.profileClose, pressed && styles.settingPressed]}>
            <Text style={styles.closeGlyph}>×</Text>
          </Pressable>}
          <Text style={styles.brand}>duo<Text style={styles.dot}>·</Text></Text>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          {!!body && <Text style={styles.body}>{body}</Text>}
          <View style={styles.fields}>{children}</View>
        </View>
      </KeyboardAwareScrollView>
  </SafeAreaView>;
}

const palette = { ink: '#204438', muted: '#52655a', background: '#f3f2eb', paper: '#fdfcf8', line: '#d8dfd4', accent: '#75a584' };
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  layout: { flexGrow: 1, justifyContent: 'center', padding: 22 },
  card: { width: '100%', alignSelf: 'center', maxWidth: 450, borderRadius: 24, padding: 24, backgroundColor: palette.paper },
  brand: { color: palette.ink, fontWeight: '800', fontSize: 38, letterSpacing: -2, marginBottom: 16 },
  dot: { color: palette.accent },
  title: { fontSize: 31, fontWeight: '700', color: palette.ink, letterSpacing: -0.6 },
  body: { color: palette.muted, fontSize: 18, lineHeight: 26, marginTop: 8 },
  fields: { gap: 10, marginTop: 20 },
  profileClose: { position: 'absolute', top: 20, right: 20, zIndex: 1 },
  headerButton: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#e7ede3' },
  closeGlyph: { color: palette.ink, fontSize: 30, lineHeight: 34 },
  backGlyph: { color: palette.ink, fontSize: 34, lineHeight: 37 },
  notificationHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, gap: 14 },
  notificationTitle: { flex: 1, fontSize: 25, fontWeight: '700', color: palette.ink },
  notificationContent: { width: '100%', alignSelf: 'center', maxWidth: 480, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 32, gap: 22 },
  notificationSection: { gap: 8 },
  notificationCard: { borderWidth: 1, borderColor: palette.line, borderRadius: 14, overflow: 'hidden', backgroundColor: palette.paper },
  notificationLink: { minHeight: 60, borderWidth: 1, borderColor: palette.line, borderRadius: 12, flexDirection: 'row',
    alignItems: 'center', paddingHorizontal: 12, gap: 10, marginTop: 8 },
  notificationBadge: { width: 36, height: 36, borderRadius: 10, backgroundColor: '#e7ede3', alignItems: 'center', justifyContent: 'center' },
  notificationIcon: { width: 23, height: 23, tintColor: palette.ink },
  notificationChevron: { fontSize: 26, color: palette.muted },
  notificationRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, gap: 12 },
  notificationDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: palette.line },
  notificationLabel: { flex: 1, fontSize: 17, fontWeight: '600', color: palette.ink },
  settingPressed: { backgroundColor: '#e7ede3' },
  signOutButton: { backgroundColor: '#a23629', marginTop: 16 },
  version: { color: palette.muted, fontSize: 13, textAlign: 'center' },
  updateBackdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20, backgroundColor: '#172f26a0' },
  updateCard: { width: '100%', maxWidth: 400, padding: 22, gap: 10, borderRadius: 24,
    borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  updateIcon: { width: 46, height: 46, borderRadius: 14, backgroundColor: '#e1efdb', alignItems: 'center', justifyContent: 'center' },
  updateGlyph: { fontSize: 29, lineHeight: 32, color: palette.ink, fontWeight: '600' },
  updateTitle: { fontSize: 24, fontWeight: '700', color: palette.ink },
  updateBody: { color: palette.muted, fontSize: 16, lineHeight: 22 },
  updateActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  updateAction: { flex: 1 },
  label: { color: palette.ink, fontWeight: '600', fontSize: 17, marginTop: 4 },
  input: { minHeight: 54, borderWidth: 1, borderColor: palette.line, borderRadius: 12, paddingHorizontal: 13, color: palette.ink, fontSize: 18 },
  button: { minHeight: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: palette.ink, padding: 10 },
  secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: palette.line },
  disabled: { opacity: 0.5 },
  buttonText: { fontSize: 18, fontWeight: '700', color: palette.paper, textAlign: 'center' },
  secondaryText: { color: palette.ink },
  googleButton: { minHeight: 48, alignSelf: 'stretch', borderRadius: 12, borderWidth: 1, borderColor: '#747775',
    backgroundColor: '#ffffff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 12 },
  googleLogo: { width: 20, height: 20, resizeMode: 'contain' },
  googleButtonText: { color: '#1f1f1f', fontSize: 16, fontWeight: '500' },
  inviteCode: { backgroundColor: palette.background, color: palette.ink, fontSize: 17, padding: 12, borderRadius: 8 },
  hint: { color: palette.muted, fontSize: 16 },
  error: { color: '#9a3828', fontSize: 16 },
});
