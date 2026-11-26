import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

const seenUpdateKey = 'duo-last-seen-update';
const automaticCheckInterval = 5 * 60 * 1000;
const updateDate = Updates.createdAt
  ? new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }).format(Updates.createdAt)
  : null;

export function useDuoUpdates() {
  const { downloadedUpdate, isChecking, isDownloading, isRestarting, isStartupProcedureRunning, isUpdatePending,
    lastCheckForUpdateTimeSinceRestart } = Updates.useUpdates();
  const checking = useRef(false);
  const lastAttempt = useRef(0);
  const shownUpdate = useRef<string | null>(null);
  const [notice, setNotice] = useState<'available' | 'applied' | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  const nativeBusy = isStartupProcedureRunning || isChecking || isDownloading || isRestarting;

  const apply = useCallback(async () => {
    setNotice(null);
    try {
      await Updates.reloadAsync();
    } catch {
      Alert.alert('No se pudo aplicar la actualización', 'Volvé a abrir Duo para cargarla.');
    }
  }, []);

  const check = useCallback(async () => {
    if (!Updates.isEnabled || checking.current || nativeBusy || isUpdatePending) return;
    const lastCheck = Math.max(lastAttempt.current, lastCheckForUpdateTimeSinceRestart?.getTime() ?? 0);
    if (Date.now() - lastCheck < automaticCheckInterval) return;

    checking.current = true;
    lastAttempt.current = Date.now();
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable || result.isRollBackToEmbedded) {
        await Updates.fetchUpdateAsync();
      }
    } catch {
      // Keep Duo usable offline and retry on a later check.
    } finally {
      checking.current = false;
    }
  }, [isUpdatePending, lastCheckForUpdateTimeSinceRestart, nativeBusy]);

  useEffect(() => {
    if (!Updates.isEnabled) return;
    const subscription = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
      if (state === 'active') void check();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void check();
    }, automaticCheckInterval);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [check]);

  const downloadedId = downloadedUpdate?.updateId ?? 'pending';
  useEffect(() => {
    if (!Updates.isEnabled || !foreground || !isUpdatePending || shownUpdate.current === downloadedId) return;
    shownUpdate.current = downloadedId;
    setNotice('available');
  }, [downloadedId, foreground, isUpdatePending]);

  useEffect(() => {
    const id = Updates.updateId;
    if (!Updates.isEnabled || Updates.isEmbeddedLaunch || !id) return;
    let active = true;
    void AsyncStorage.getItem(seenUpdateKey).then(async seen => {
      if (!active || seen === id) return;
      await AsyncStorage.setItem(seenUpdateKey, id);
      if (active && !shownUpdate.current) setNotice('applied');
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  return {
    version: Updates.runtimeVersion,
    updateDate,
    pending: Updates.isEnabled && isUpdatePending,
    busy: nativeBusy,
    notice,
    dismissNotice: () => setNotice(null),
    apply,
  };
}
