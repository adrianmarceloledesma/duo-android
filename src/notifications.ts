import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { upcomingDueDateReminders } from './dueDates';
import type { DueDate } from './dueDates';

const reminderChannel = 'duo-recordatorios-vencimientos';
const overdueChannel = 'duo-vencimientos-atrasados';
const debtChannel = 'duo-deudas-pagos';
const sharedExpenseChannel = 'duo-gastos-compartidos';
const deviceKey = 'duo-notification-device-v1';
const preferenceKey = (userId: string) => `duo-notifications-v1:${userId}`;

export type NotificationPreference = 'reminders' | 'overdue' | 'debtPayments' | 'sharedExpenses' | 'showDescriptions';
type Preferences = Record<NotificationPreference, boolean>;
type RemotePreferences = Pick<Preferences, 'debtPayments' | 'sharedExpenses' | 'showDescriptions'>;
const remoteOff: RemotePreferences = { debtPayments: false, sharedExpenses: false, showDescriptions: false };
const defaults: Preferences = { reminders: false, overdue: false, ...remoteOff };

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

async function ensureChannels() {
  if (Platform.OS !== 'android') return;
  await Promise.all([
    Notifications.setNotificationChannelAsync(reminderChannel, {
      name: 'Recordatorios de vencimientos', importance: Notifications.AndroidImportance.DEFAULT,
    }),
    Notifications.setNotificationChannelAsync(overdueChannel, {
      name: 'Vencimientos atrasados', importance: Notifications.AndroidImportance.DEFAULT,
    }),
    Notifications.setNotificationChannelAsync(debtChannel, {
      name: 'Deudas y pagos', importance: Notifications.AndroidImportance.DEFAULT,
    }),
    Notifications.setNotificationChannelAsync(sharedExpenseChannel, {
      name: 'Gastos compartidos', importance: Notifications.AndroidImportance.DEFAULT,
    }),
  ]);
}

export async function showTestNotification() {
  await ensureChannels();
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;

  await Notifications.scheduleNotificationAsync({
    content: { title: 'Aviso de prueba de Duo', body: 'Este celular puede recibir avisos de vencimientos.', sound: 'default' },
    trigger: Platform.OS === 'android' ? { channelId: reminderChannel } : null,
  });
  return true;
}

let registrationSync = Promise.resolve();
function setRemoteRegistration(
  client: SupabaseClient, { debtPayments, sharedExpenses, showDescriptions }: RemotePreferences,
  devicePushToken?: Notifications.DevicePushToken,
) {
  const enabled = debtPayments || sharedExpenses;
  const sync = registrationSync.then(async () => {
    let deviceId = await AsyncStorage.getItem(deviceKey);
    if (!deviceId && !enabled) return;
    if (!deviceId) {
      deviceId = randomUUID();
      await AsyncStorage.setItem(deviceKey, deviceId);
    }
    const token = enabled ? (await Notifications.getExpoPushTokenAsync({ devicePushToken })).data : null;
    const fields = { p_device_id: deviceId, p_token: token };
    const pushPreferences = { ...fields, p_debt_payments: debtPayments, p_shared_expenses: sharedExpenses };
    let { error } = await client.rpc('duo_set_push_preferences', {
      ...pushPreferences, p_show_description: showDescriptions,
    });
    if (error?.code === 'PGRST202' && (!showDescriptions || !enabled)) {
      ({ error } = await client.rpc('duo_set_push_preferences', pushPreferences));
      if (error?.code === 'PGRST202' && !sharedExpenses) {
        ({ error } = await client.rpc('duo_set_push_device', fields));
      }
    }
    if (error && (enabled || error.code !== 'PGRST202')) throw error;
  });
  registrationSync = sync.catch(() => {});
  return sync;
}

function remoteRegistrationError(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'PGRST202') return 'Los avisos todavía necesitan activarse en la cuenta de Duo.';
  if (code === 'ERR_NOTIFICATIONS_NETWORK_ERROR') return 'Revisá tu conexión y volvé a activar los avisos.';
  return 'No pudimos registrar este celular para recibir avisos. Volvé a intentarlo.';
}

type PendingDueDate = Pick<DueDate, 'id' | 'title' | 'date' | 'paymentWindowDays' | 'remindDaily'>;

function reminderKey(type: unknown, id: unknown, at: unknown) {
  return `${type}:${id}:${at}`;
}

let reminderSync = Promise.resolve();
function syncReminders(userId: string, dueDates: PendingDueDate[], reminders = false, overdue = false) {
  const sync = reminderSync.then(async () => {
    const permitted = await Notifications.getPermissionsAsync();
    const now = new Date();
    const upcoming = new Map((permitted.granted ? dueDates : []).flatMap(item => {
      const description = item.title.trim().replace(/\s+/g, ' ');
      return upcomingDueDateReminders(item, now, reminders, overdue).map(notice => {
        const showOpening = notice.opensPaymentWindow && !!description;
        const title = showOpening ? `Ya podés pagar ${description}` : notice.title;
        const body = showOpening
          ? (item.paymentWindowDays === 0 ? 'Vence hoy.' : undefined)
          : description || 'Tenés un pago pendiente en Duo.';
        return [reminderKey(notice.type, item.id, notice.at), { ...notice, item, title, body }] as const;
      });
    }));
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const notice of scheduled) {
      const data = notice.content.data;
      if (data?.ownerId !== userId || (data.duoType !== 'overdue-due-date' && data.duoType !== 'due-date-reminder')) continue;
      const key = reminderKey(data.duoType, data.dueDateId, data.at);
      const planned = upcoming.get(key);
      if (planned && planned.title === notice.content.title && planned.body === (notice.content.body ?? undefined)) upcoming.delete(key);
      else await Notifications.cancelScheduledNotificationAsync(notice.identifier);
    }
    if (upcoming.size) await ensureChannels();
    for (const { item, at, type, title, body } of upcoming.values()) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          data: { duoType: type, ownerId: userId, dueDateId: item.id, dueMonth: item.date.slice(0, 7), at },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE, date: at,
          channelId: type === 'overdue-due-date' ? overdueChannel : reminderChannel,
        },
      });
    }
  });
  reminderSync = sync.catch(() => {});
  return sync;
}

export function useDuoNotifications(client: SupabaseClient, userId: string, dueDates?: DueDate[]) {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signingOut = useRef(false);
  const updating = useRef(false);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(preferenceKey(userId)).then(raw => {
      const saved = raw ? JSON.parse(raw) as Partial<Preferences> : defaults;
      if (active) setPreferences({
        reminders: saved.reminders === true, overdue: saved.overdue === true,
        debtPayments: saved.debtPayments === true, sharedExpenses: saved.sharedExpenses === true,
        showDescriptions: saved.showDescriptions === true,
      });
    }).catch(() => {
      if (active) setPreferences(defaults);
    });
    return () => { active = false; };
  }, [userId]);

  const remindersEnabled = preferences?.reminders;
  const overdueEnabled = preferences?.overdue;
  const showDescriptions = preferences?.showDescriptions === true;
  const pendingDates = dueDates ? JSON.stringify(dueDates.filter(item => !item.paidOn).map(
    ({ id, title, date, paymentWindowDays, remindDaily }) => ({ id, title, date, paymentWindowDays, remindDaily })
  )) : null;
  useEffect(() => {
    if (remindersEnabled === undefined || pendingDates === null) return;
    const dates: PendingDueDate[] = JSON.parse(pendingDates);
    function refreshReminders() {
      if (signingOut.current) return;
      void syncReminders(userId, dates, remindersEnabled, overdueEnabled)
        .catch(() => setError('No pudimos programar los avisos de vencimientos.'));
    }
    refreshReminders();
    const resumed = AppState.addEventListener('change', state => { if (state === 'active') refreshReminders(); });
    return () => resumed.remove();
  }, [pendingDates, remindersEnabled, overdueEnabled, userId]);

  const debtEnabled = preferences?.debtPayments === true;
  const expensesEnabled = preferences?.sharedExpenses === true;
  useEffect(() => {
    if (!debtEnabled && !expensesEnabled) return;
    let active = true;
    async function refreshRegistration(token?: Notifications.DevicePushToken) {
      if (signingOut.current || updating.current) return;
      try {
        await ensureChannels();
        const { granted } = await Notifications.getPermissionsAsync();
        if (active && !signingOut.current && !updating.current) {
          await setRemoteRegistration(client, granted
            ? { debtPayments: debtEnabled, sharedExpenses: expensesEnabled, showDescriptions }
            : remoteOff, token);
        }
      } catch (error) {
        if (active) setError(remoteRegistrationError(error));
      }
    }
    void refreshRegistration();
    const rotated = Notifications.addPushTokenListener(token => { void refreshRegistration(token); });
    const resumed = AppState.addEventListener('change', state => { if (state === 'active') void refreshRegistration(); });
    return () => { active = false; rotated.remove(); resumed.remove(); };
  }, [client, debtEnabled, expensesEnabled, showDescriptions]);

  async function setPreference(key: NotificationPreference, enabled: boolean) {
    if (!preferences || updating.current) return;
    updating.current = true;
    setBusy(true);
    setError('');
    const remote = key === 'debtPayments' || key === 'sharedExpenses'
      || (key === 'showDescriptions' && (preferences.debtPayments || preferences.sharedExpenses));
    try {
      if (enabled && key !== 'showDescriptions') {
        await ensureChannels();
        const current = await Notifications.getPermissionsAsync();
        const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
        if (!permission.granted) {
          setError('Activá las notificaciones de Duo desde los ajustes de Android.');
          return;
        }
      }
      const next = { ...preferences, [key]: enabled };
      if (remote) await setRemoteRegistration(client, next);
      await AsyncStorage.setItem(preferenceKey(userId), JSON.stringify(next));
      setPreferences(next);
    } catch (error) {
      setError(remote ? remoteRegistrationError(error) : 'No pudimos guardar tus avisos de vencimientos.');
    } finally {
      updating.current = false;
      setBusy(false);
    }
  }

  async function disconnect() {
    signingOut.current = true;
    await Promise.allSettled([syncReminders(userId, []), setRemoteRegistration(client, remoteOff).catch(async () => {
      if (debtEnabled || expensesEnabled) await Notifications.unregisterForNotificationsAsync();
    })]);
  }

  return { preferences, busy, error, setPreference, disconnect };
}
