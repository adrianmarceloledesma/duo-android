import { createContext, useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentRef, ReactNode } from 'react';
import {
  AccessibilityInfo, Alert, Animated, Easing, Image, Keyboard, PanResponder, Platform, Pressable, RefreshControl,
  ScrollView, StyleSheet, Text,
  TextInput, View,
} from 'react-native';
import type { ImageSourcePropType, PressableProps, StyleProp, ViewStyle } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { getPendingResultAsync, launchImageLibraryAsync } from 'expo-image-picker';
import { clearLastNotificationResponseAsync, useLastNotificationResponse } from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { KeyboardAwareScrollView, KeyboardProvider, KeyboardStickyView } from 'react-native-keyboard-controller';
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CATEGORIES, CATEGORY_GROUPS, CATEGORY_PICKER, PEOPLE, SEED_DATA,
  cashHeading, compareAddedTime, exactBalanceOption, findMovement, formatMoneyInput, getBalance, getMetrics, getMonthlyCash, getSavingsBalance, monthKey, monthName, movementOwner, parseMoneyInput, previousMonth, reviseMovement,
  type Category, type CategoryGroup, type Currency, type Debt, type DuoData, type Expense, type ExpenseDraft, type ExpenseFilter, type Income, type OtherMovement, type PersonId, type SavingMove, type Tab, type Transfer,
} from './src/domain';
import { finishCoverPicker, loadCoverPhoto, loadDemoData, rememberCoverPicker, removeCoverPhoto, resetDemoData, saveCoverPhoto, saveDemoData } from './src/storage';
import { AccountEntry } from './src/Account';
import { SafeAreaModal } from './src/SafeAreaModal';
import { getCategoryIcon } from './src/categoryIcons';
import { cloudClient, cloudError } from './src/cloud';
import { ExpenseReceiptSection } from './src/ExpenseReceiptSection';
import { attachReceipt, cleanupReceipts, expenseIdForRequest, receiptError } from './src/receipts';
import { releaseReceipt } from './src/receiptFiles';
import type { ReceiptFile } from './src/receiptTypes';
import { ExpenseSearchBar, ExpenseSearchSummary, ExpenseSearchToggle } from './src/ExpenseSearchBar';
import { buildExpenseSearchIndex, EMPTY_EXPENSE_SEARCH, filterExpenseSearch, hasExpenseSearch } from './src/expenseSearch';
import type { ExpenseSearch } from './src/expenseSearch';
import { changeDemoCashInterest, settleDemoCashInterest } from './src/cashInterest';
import { PersonalInterestControl } from './src/PersonalInterestControl';
import { changeDemoInterest, changeDemoSharedInterest, dailyPersonalInterest, interestBusinessDay, settleDemoInterest, settleDemoSharedInterest } from './src/savingsInterest';
import type { CloudChange, CloudDashboard, ExpenseChange, MovementChange } from './src/cloud';
import { generateDueDateOccurrences, moveDueDateToMonth, payableFromDate, paymentWindowDays } from './src/dueDates';
import type { DueDate, DueDateChange, DueDateDraft, DueDatePayment, DueDateSchedule } from './src/dueDates';

type FormName = OtherMovement['kind'] | null;
type ExpenseView = { mode: 'new' } | { mode: 'detail' | 'edit'; id: string };
type MovementView = { kind: OtherMovement['kind']; id: string; editing: boolean };
type DueDateModalState = { type: 'save'; id?: string } | { type: 'copy' } | { type: 'pay'; id: string };
type OpenMovement = (movement: OtherMovement, editing?: boolean) => void;
type AnalysisMode = 'own' | 'shared';
type NewIncome = Omit<Income, 'id' | 'owner'>;
type NewSaving = Omit<SavingMove, 'id' | 'owner' | 'account'>;
type NewTransfer = Pick<Transfer, 'amount' | 'date' | 'note' | 'currency'>;
type NewDebt = Pick<Debt, 'amount' | 'date' | 'note'>;
type AmountEntry = string | number;
const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const dateInput = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parseDate = (value: string) => new Date(`${value}T12:00:00`);
function shiftMonth(month: string, offset: number) {
  const date = parseDate(`${month}-15`);
  date.setMonth(date.getMonth() + offset);
  return monthKey(dateInput(date));
}
const formatDate = (value: string) => new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'short' }).format(parseDate(value));
const longDate = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
const formatMonth = (value: string) => new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric' }).format(parseDate(`${value}-15`));
const amountFormat = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
const money = (amount: number, currency: Currency = 'ARS') =>
  `${currency === 'USD' ? 'US$' : '$'} ${amountFormat.format(Math.abs(amount))}`;
const currentMonth = dateInput().slice(0, 7);
const currencyPages = ['ARS', 'USD'] as const;
const expenseFilters = [['all', 'Todos'], ['shared', 'Compartidos'], ['personal', 'Personales']] as const;
const mainTabs = [
  { id: 'gastos', label: 'Gastos', icon: require('./assets/tabs/gastos.png') },
  { id: 'vencimientos', label: 'Vencimientos', icon: require('./assets/tabs/vencimientos.png') },
  { id: 'ahorros', label: 'Ahorros', icon: require('./assets/tabs/ahorros.png') },
  { id: 'analisis', label: 'Análisis', icon: require('./assets/tabs/analisis.png') },
] as const;
const PeopleContext = createContext(PEOPLE);
const ReduceMotionContext = createContext(true);
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function dueDatesToCopy(dueDates: DueDate[], targetMonth: string) {
  const sourceMonth = previousMonth(targetMonth);
  const copies = dueDates.filter(item => item.copiedMonth === targetMonth);
  const copiedIds = new Set(copies.map(item => item.copiedFrom));
  const copiedSchedules = new Set(copies.map(item => item.scheduleId));
  return dueDates.filter(item => monthKey(item.date) === sourceMonth && !item.repeatsMonthly
      && !copiedIds.has(item.id) && (!item.scheduleId || !copiedSchedules.has(item.scheduleId)))
    .sort((first, second) => first.date.localeCompare(second.date));
}

async function restoreCoverPhoto(ownerId?: string) {
  const savedCover = await loadCoverPhoto(ownerId).catch(() => null);
  if (Platform.OS !== 'android') return savedCover;

  try {
    const originalPicker = await finishCoverPicker(ownerId);
    if (originalPicker) {
      const pending = await getPendingResultAsync();
      if (pending && 'assets' in pending && pending.assets?.[0]) {
        return await saveCoverPhoto(pending.assets[0].uri, makeId(), ownerId);
      }
    }
  } catch {
    // Keep the previous cover if Android could not recover the selected file.
  }
  return savedCover;
}

function Label({ children }: { children: string }) { return <Text style={styles.overline}>{children}</Text>; }
function MotionButton({ style, onPressIn, onPressOut, ...props }: Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useContext(ReduceMotionContext);
  const [scale] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (reduceMotion || props.disabled) scale.setValue(1);
    return () => scale.stopAnimation();
  }, [props.disabled, reduceMotion, scale]);

  function animate(toValue: number, duration: number) {
    if (reduceMotion) return;
    Animated.timing(scale, {
      toValue, duration, easing: Easing.out(Easing.cubic), useNativeDriver: true, isInteraction: false,
    }).start();
  }

  return <AnimatedPressable {...props} style={[style, { transform: [{ scale }] }]}
    onPressIn={event => { animate(0.96, 85); onPressIn?.(event); }}
    onPressOut={event => { animate(1, 145); onPressOut?.(event); }}/>;
}

function Pill({ children, active = false, accessibilityLabel, onPress, compact = false }: {
  children: string; active?: boolean; accessibilityLabel?: string; onPress: () => void; compact?: boolean;
}) {
  return <MotionButton accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    accessibilityState={{ selected: active }} onPress={onPress}
    style={[styles.pill, compact && styles.compactPill, active && styles.pillActive]}>
    <Text style={[styles.pillText, active && styles.pillTextActive]}>{children}</Text>
  </MotionButton>;
}

function useReduceMotion() {
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(enabled => {
      if (mounted) setReduceMotion(enabled);
    }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
}

function MainTabBar({ activeTab, onSelect }: { activeTab: Tab; onSelect: (tab: Tab) => void }) {
  const reduceMotion = useContext(ReduceMotionContext);
  return <SafeAreaView edges={['bottom']} style={styles.tabBarInset}>
    <View style={styles.tabBar} accessibilityRole="tablist">
      {mainTabs.map(({ id, label, icon }) => <MainTabButton key={id} label={label} icon={icon}
        active={activeTab === id} reduceMotion={reduceMotion} onPress={() => onSelect(id)}/>)}
    </View>
  </SafeAreaView>;
}

function MainTabButton({ label, icon, active, reduceMotion, onPress }: {
  label: string; icon: ImageSourcePropType; active: boolean; reduceMotion: boolean; onPress: () => void;
}) {
  const [progress] = useState(() => new Animated.Value(0));
  const previouslyActive = useRef(active);
  useEffect(() => {
    const becameActive = active && !previouslyActive.current;
    previouslyActive.current = active;
    progress.setValue(0);
    if (!becameActive || reduceMotion) return;

    const easing = Easing.out(Easing.cubic);
    const animation = Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration: 105, easing, useNativeDriver: true }),
      Animated.timing(progress, { toValue: 0, duration: 155, easing, useNativeDriver: true }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [active, progress, reduceMotion]);

  return <Pressable onPress={onPress} style={styles.tabItem} accessibilityRole="tab"
    accessibilityLabel={label} accessibilityState={{ selected: active }}>
    <View style={[styles.tabIconFrame, active && styles.tabIconFrameActive]}>
      <Animated.View style={{ transform: [
        { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, -2] }) },
        { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.14] }) },
      ] }}>
        <Image source={icon} accessible={false} style={[styles.tabIcon, active && styles.tabIconActive]}/>
      </Animated.View>
    </View>
    <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
  </Pressable>;
}

function SwipePages({ page, onPageChange, pages, resetKey }: {
  page: number;
  onPageChange?: (page: number) => void;
  pages: { key: string; content: ReactNode }[];
  resetKey?: string;
}) {
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<number[]>([]);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const position = useRef({ page, width: 0, resetKey });
  const contentWidth = useRef(0);
  const dragged = useRef(false);

  function syncPosition(animate: boolean) {
    const previous = position.current;
    const reset = previous.resetKey !== resetKey;
    // View layout can precede native content layout. An early scrollTo gets
    // clamped to page zero; only mark the position applied once all pages fit.
    if (!width || !scroll.current || Math.abs(contentWidth.current - pages.length * width) > 1
      || (!reset && previous.page === page && previous.width === width)) return;
    dragged.current = false;
    scroll.current.scrollTo({ x: page * width, animated: animate && !reset && previous.width === width });
    position.current = { page, width, resetKey };
  }

  useLayoutEffect(() => {
    syncPosition(true);
  }, [page, resetKey, width, pages.length]);

  const pageHeight = heights[page];
  const tallest = heights.reduce((height, next) => Math.max(height, next), 0);
  const extraHeight = pageHeight === undefined ? 0 : tallest - pageHeight;
  return <View style={styles.swipeViewport} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <ScrollView ref={scroll} horizontal pagingEnabled directionalLockEnabled scrollEnabled={!!onPageChange}
      showsHorizontalScrollIndicator={false} removeClippedSubviews={false}
      contentContainerStyle={styles.swipeContent}
      onContentSizeChange={nextWidth => {
        contentWidth.current = nextWidth;
        syncPosition(false);
      }}
      // Keep the pages measurable but give the vertical scroll only the selected page's height.
      style={{ marginBottom: -extraHeight }}
      onScrollBeginDrag={() => { dragged.current = true; }}
      onMomentumScrollEnd={event => {
        if (!width || !dragged.current) return;
        dragged.current = false;
        const index = Math.min(pages.length - 1, Math.max(0, Math.round(event.nativeEvent.contentOffset.x / width)));
        position.current = { page: index, width, resetKey };
        onPageChange?.(index);
      }}>
      {width > 0 && pages.map(({ key, content }, index) => <View key={key} style={{ width }}
        onLayout={event => {
          const { height } = event.nativeEvent.layout;
          setHeights(previous => {
            if (previous[index] === height) return previous;
            const next = [...previous];
            next[index] = height;
            return next;
          });
        }}
        accessibilityElementsHidden={index !== page}
        importantForAccessibility={index === page ? 'auto' : 'no-hide-descendants'}>
        {content}
      </View>)}
    </ScrollView>
  </View>;
}
function CategoryMark({ category, small = false }: { category: Category | CategoryGroup; small?: boolean }) {
  return <View style={[styles.categoryMark, small && styles.categoryMarkSmall]}>
    <Image source={getCategoryIcon(category)} resizeMode="contain" accessible={false}
      style={[styles.categoryGlyph, small && styles.categoryGlyphSmall]}/>
  </View>;
}

function CategoryPicker({ category, groupId, exclude, onSelect, onGroupChange }: {
  category?: Category; groupId: CategoryGroup | null;
  exclude?: ReadonlySet<Category>;
  onSelect: (category: Category) => void; onGroupChange: (group: CategoryGroup | null) => void;
}) {
  const group = CATEGORY_GROUPS.find(item => item.id === groupId);
  const options = (group?.children ?? CATEGORY_PICKER).filter(item => 'children' in item ? item.children.some(child => !exclude?.has(child.id)) : !exclude?.has(item.id));

  return <View style={styles.field}>
    {group ? <View style={styles.categoryHeading}>
      <MotionButton accessibilityRole="button" accessibilityLabel="Volver a todas las categorías"
        onPress={() => onGroupChange(null)} style={styles.categoryBack}>
        <Text style={styles.categoryBackArrow}>‹</Text>
        <Text style={styles.categoryBackText}>Todas las categorías</Text>
      </MotionButton>
      <Text accessibilityRole="header" style={styles.expenseLabel}>{group.label}</Text>
    </View> : <Text style={styles.expenseLabel}>Categoría</Text>}
    <View style={styles.categoryGrid}>
      {options.map(item => {
        const isGroup = 'children' in item;
        const selected = isGroup ? item.children.some(child => child.id === category) : category === item.id;
        return <MotionButton key={item.id} accessibilityRole={isGroup ? 'button' : 'radio'}
          accessibilityLabel={item.label} accessibilityHint={isGroup ? 'Abre las subcategorías' : undefined}
          accessibilityState={isGroup ? { selected } : { checked: selected }}
          onPress={() => isGroup ? onGroupChange(item.id) : onSelect(item.id)}
          style={[styles.categoryChoice, selected && styles.categoryChoiceActive]}>
          <CategoryMark category={item.id}/>
          <Text style={styles.categoryChoiceText}>{item.label}</Text>
          {isGroup && <Text style={styles.categoryChevron}>›</Text>}
        </MotionButton>;
      })}
    </View>
  </View>;
}
function ActionButton({ title, onPress, light = false }: { title: string; onPress: () => void; light?: boolean }) {
  return <MotionButton accessibilityRole="button" onPress={onPress} style={[styles.actionButton, light && styles.actionButtonLight]}>
    <Text style={[styles.actionText, light && styles.actionTextLight]}>＋  {title}</Text>
  </MotionButton>;
}

export default function App() {
  const reduceMotion = useReduceMotion();
  useEffect(() => {
    if (Updates.isEnabled && !Updates.isEmbeddedLaunch && Updates.updateId) {
      console.info(`[Duo] Actualización activa ${Updates.updateId}`);
    }
  }, []);

  return <SafeAreaProvider initialMetrics={initialWindowMetrics}>
    <KeyboardProvider statusBarTranslucent navigationBarTranslucent preload={false}>
      <ReduceMotionContext.Provider value={reduceMotion}>
        <AccountEntry Dashboard={DuoDashboard}/>
      </ReduceMotionContext.Provider>
    </KeyboardProvider>
  </SafeAreaProvider>;
}

function DuoDashboard({ cloud, onExitDemo }: { cloud?: CloudDashboard; onExitDemo?: () => void }) {
  const { bottom: navigationInset } = useSafeAreaInsets();
  const [demoData, setDemoData] = useState<DuoData>(SEED_DATA);
  const data = cloud?.data ?? demoData;
  const people = cloud?.names ?? PEOPLE;
  const ownerId = cloud?.userId;
  const linked = cloud?.linked ?? true;
  const dueDatePaymentsEnabled = cloud?.dueDatePaymentsEnabled ?? true;
  const dueDateRecurrenceEnabled = cloud?.dueDateRecurrenceEnabled ?? true;
  const setDueDateViewMonth = cloud?.setDueDateViewMonth;
  const [active, setActive] = useState<PersonId>('adri');
  const [interestDay, setInterestDay] = useState(interestBusinessDay);
  const [tab, setTab] = useState<Tab>('gastos');
  const [expenseFilter, setExpenseFilter] = useState<ExpenseFilter>('all');
  const notificationResponse = useLastNotificationResponse();
  const balanceHandlesSwipe = useRef(false);
  const expenseSwipe = useMemo(() => {
    let start: { x: number; y: number } | undefined;
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: ({ nativeEvent }) => {
        balanceHandlesSwipe.current = false;
        start = nativeEvent.touches.length === 1 ? { x: nativeEvent.pageX, y: nativeEvent.pageY } : undefined;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_, { dx, dy, numberActiveTouches }) =>
        !!start && !balanceHandlesSwipe.current && numberActiveTouches === 1 && Math.abs(dx) >= 12 && Math.abs(dx) > Math.abs(dy) * 1.4,
      onPanResponderRelease: ({ nativeEvent }) => {
        if (!start) return;
        const dx = nativeEvent.pageX - start.x;
        const dy = nativeEvent.pageY - start.y;
        if (Math.abs(dx) < 44 || Math.abs(dx) <= Math.abs(dy) * 1.4) return;
        const offset = dx < 0 ? 1 : -1;
        setExpenseFilter(current => {
          const page = expenseFilters.findIndex(([filter]) => filter === current);
          return expenseFilters[page + offset]?.[0] ?? current;
        });
      },
    });
  }, []);
  const [form, setForm] = useState<FormName>(null);
  const [expenseView, setExpenseView] = useState<ExpenseView | null>(null);
  const [movementView, setMovementView] = useState<MovementView | null>(null);
  const [loaded, setLoaded] = useState(!!ownerId);
  const [month, setMonth] = useState(currentMonth);
  const [dueMonth, setDueMonth] = useState(currentMonth);
  useEffect(() => {
    if (!ownerId || !notificationResponse) return;
    const notice = notificationResponse.notification.request.content.data;
    if ((notice?.duoType === 'overdue-due-date' || notice?.duoType === 'due-date-reminder') && notice.ownerId === ownerId) {
      setDueMonth(typeof notice.dueMonth === 'string' ? notice.dueMonth : monthKey(dateInput()));
      setTab('vencimientos');
    } else if ((notice?.duoType === 'shared-debt-payment' || notice?.duoType === 'shared-expense') && linked) {
      setExpenseFilter('shared');
      setTab('gastos');
    }
    void clearLastNotificationResponseAsync().catch(() => {});
  }, [linked, notificationResponse, ownerId]);
  const [dueModal, setDueModal] = useState<DueDateModalState | null>(null);
  const [dueDeleteId, setDueDeleteId] = useState<string | null>(null);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('own');
  const [transferCurrency, setTransferCurrency] = useState<Currency>('ARS');
  const [savingAccount, setSavingAccount] = useState<SavingMove['account']>('personal');
  const [savingFormAccount, setSavingFormAccount] = useState<SavingMove['account']>('personal');
  const [notice, setNotice] = useState('');
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const receiptOperation = useRef(false);
  const trackReceiptOperation = useCallback((busy: boolean) => { receiptOperation.current = busy; }, []);
  const [refreshing, setRefreshing] = useState(false);
  const coverOperation = useRef(false);
  const saveOperation = useRef(false);
  const requestKeys = useRef(new Map<string, string>());
  const balance = useMemo(() => getBalance(data, active), [data, active]);
  const dollarBalance = useMemo(() => getBalance(data, active, 'USD'), [data, active]);
  const visibleExpenses = useMemo(() => [...data.expenses].filter((e) => e.shared || e.paidBy === active).sort(compareAddedTime), [data.expenses, active]);
  const allDueDates = data.dueDates ?? [];
  const ownDueDates = allDueDates.filter(item => item.owner === active);
  const dueDateToDelete = ownDueDates.find(item => item.id === dueDeleteId);
  const selectedDueDate = dueModal && dueModal.type !== 'copy' ? ownDueDates.find(item => item.id === dueModal.id) : undefined;
  const dueDateBeingEdited = dueModal?.type === 'save' ? selectedDueDate : undefined;
  const activePaymentExpense = (item: DueDate) => data.expenses.some(expense => item.paymentExpenseIds?.includes(expense.id));
  const previousCopyCandidates = dueDatesToCopy(ownDueDates, dueMonth);
  const selectedExpense = expenseView && expenseView.mode !== 'new'
    ? visibleExpenses.find(expense => expense.id === expenseView.id)
    : undefined;
  const editingExpense = expenseView?.mode === 'edit' && selectedExpense?.paidBy === active;
  const expenseModalOpen = expenseView?.mode === 'new' || !!selectedExpense;
  const openExpense = (id: string) => setExpenseView({ mode: 'detail', id });
  const newExpense = () => setExpenseView({ mode: 'new' });
  const selectedMovement = movementView ? findMovement(data, movementView.kind, movementView.id) : undefined;
  const openMovement: OpenMovement = (movement, editing = false) => setMovementView({
    kind: movement.kind, id: movement.entry.id, editing,
  });
  const editingMovement = !!movementView?.editing && !!selectedMovement && movementOwner(selectedMovement) === active;

  useEffect(() => {
    let mounted = true;
    void Promise.all([ownerId ? null : loadDemoData(), restoreCoverPhoto(ownerId)]).then(([savedData, photo]) => {
      if (!mounted) return;
      if (savedData) setDemoData(savedData);
      setCoverUri(photo);
      setLoaded(true);
    });
    return () => { mounted = false; };
  }, [ownerId]);

  async function updateCover(remove: boolean) {
    if (coverOperation.current) return;
    coverOperation.current = true;
    setCoverBusy(true);
    try {
      if (remove) {
        await removeCoverPhoto(ownerId);
        setCoverUri(null);
      } else {
        if (Platform.OS === 'android') await rememberCoverPicker(ownerId);
        const result = await launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          aspect: [16, 9],
          quality: 0.8,
        });
        if (!result.canceled && result.assets[0]) {
          setCoverUri(await saveCoverPhoto(result.assets[0].uri, makeId(), ownerId));
        }
      }
    } catch {
      Alert.alert(
        remove ? 'No se pudo quitar la foto' : 'No se pudo guardar la foto',
        remove ? 'Volvé a intentarlo.' : 'Volvé a intentarlo o elegí otra foto de la galería.',
      );
    } finally {
      if (!remove && Platform.OS === 'android') await finishCoverPicker(ownerId).catch(() => false);
      coverOperation.current = false;
      setCoverBusy(false);
    }
  }
  const persist = useCallback((next: DuoData) => {
    setDemoData(next);
    saveDemoData(next).catch(() => Alert.alert('No se pudo guardar', 'El movimiento se verá durante esta sesión, pero no quedó guardado en el teléfono.'));
  }, []);
  useEffect(() => {
    if (cloud) return;
    const timer = setInterval(() => setInterestDay(interestBusinessDay()), 60000);
    return () => clearInterval(timer);
  }, [cloud]);
  useEffect(() => {
    if (cloud || !loaded) return;
    const next = settleDemoCashInterest(settleDemoSharedInterest(settleDemoInterest(demoData, active, interestDay), interestDay), active, interestDay);
    if (next !== demoData) persist(next);
  }, [active, cloud, demoData, interestDay, loaded, persist]);
  async function updatePersonalInterest(annualPercent: number) {
    if (cloud) await cloud.setPersonalInterest(annualPercent);
    else persist(changeDemoInterest(demoData, active, annualPercent, interestBusinessDay()));
  }
  async function updateCashInterest(annualPercent: number) {
    if (cloud) await cloud.setCashInterest(annualPercent);
    else persist(changeDemoCashInterest(demoData, active, annualPercent, interestBusinessDay()));
  }
  async function updateSharedInterest(annualPercent: number) {
    if (cloud) await cloud.setSharedInterest(annualPercent);
    else persist(changeDemoSharedInterest(demoData, annualPercent, interestBusinessDay()));
  }
  const todayMonth = monthKey(dateInput());
  const visibleDueMonth = tab === 'vencimientos' ? (dueMonth > todayMonth ? dueMonth : todayMonth) : null;

  useEffect(() => {
    setDueDateViewMonth?.(dueDateRecurrenceEnabled ? visibleDueMonth : null);
  }, [dueDateRecurrenceEnabled, setDueDateViewMonth, visibleDueMonth]);

  useEffect(() => {
    if (!loaded || cloud || !visibleDueMonth || !demoData.dueDateSchedules?.length) return;
    const generated = generateDueDateOccurrences(demoData.dueDateSchedules, active, visibleDueMonth, makeId);
    if (!generated.dueDates.length) return;
    persist({
      ...demoData,
      dueDates: [...generated.dueDates, ...(demoData.dueDates ?? [])],
      dueDateSchedules: generated.schedules,
    });
  }, [active, cloud, demoData, loaded, persist, visibleDueMonth]);
  const announce = (value: string) => { setNotice(value); setTimeout(() => setNotice(''), 2100); };
  function closeForm() {
    if (saveOperation.current) return;
    requestKeys.current.clear();
    setForm(null);
    setExpenseView(null);
    setMovementView(null);
    setDueModal(null);
    setDueDeleteId(null);
  }
  function closeExpense() {
    if (saveOperation.current || receiptOperation.current) return;
    if (editingExpense && selectedExpense) openExpense(selectedExpense.id);
    else closeForm();
  }
  async function saveMovement(change: CloudChange | ExpenseChange | MovementChange | DueDateChange, demoNext: DuoData, message: string, afterSave = closeForm,
    afterWrite?: (requestKey: string) => Promise<void>) {
    if (saveOperation.current) return;
    if (cloud) {
      saveOperation.current = true;
      setSaving(true);
      const signature = JSON.stringify(change);
      const requestKey = requestKeys.current.get(signature) ?? `${makeId()}-${makeId()}`;
      requestKeys.current.set(signature, requestKey);
      try {
        await cloud.write(change, requestKey);
        await afterWrite?.(requestKey);
        if (change.kind === 'delete-expense' && cloudClient) await cleanupReceipts(cloudClient);
      } catch (error) {
        const title = change.kind === 'delete-expense' ? 'No se pudo eliminar el gasto'
          : change.kind === 'delete-movement' ? 'No se pudo eliminar el registro' : 'No se pudo confirmar el guardado';
        Alert.alert(title, cloudError(error, 'Revisá la conexión y volvé a intentar.'));
        return;
      } finally {
        saveOperation.current = false;
        setSaving(false);
      }
    } else {
      persist(demoNext);
    }
    if (change.kind === 'income') setMonth(change.entry.date.slice(0, 7));
    requestKeys.current.clear();
    afterSave();
    announce(message);
  }
  async function refreshDashboard() {
    if (!cloud || refreshing) return;
    setRefreshing(true);
    await cloud.refresh();
    setRefreshing(false);
  }
  const addExpense = (entry: ExpenseDraft, file?: ReceiptFile | null) => {
    let savedId: string | undefined;
    void saveMovement({ kind: 'expense', entry }, { ...data, expenses: [{ ...entry, id: makeId(), paidBy: active, createdAt: new Date().toISOString() }, ...data.expenses] }, 'Gasto guardado',
      () => savedId ? openExpense(savedId) : closeForm(), file && cloud && cloudClient ? async requestKey => {
        try {
          savedId = await expenseIdForRequest(cloudClient!, requestKey);
          await attachReceipt(cloudClient!, savedId, file, null);
        } catch (error) {
          Alert.alert('Gasto guardado, comprobante pendiente', `${receiptError(error)} Podés adjuntarlo desde el detalle del gasto.`);
        }
      } : undefined);
  };
  function editExpense(entry: ExpenseDraft) {
    if (!editingExpense || !selectedExpense) return;
    const { id } = selectedExpense;
    const expenses = data.expenses.map(expense => expense.id === id ? { ...expense, ...entry } : expense);
    void saveMovement({ kind: 'edit-expense', id, entry }, { ...data, expenses }, 'Gasto actualizado', () => openExpense(id));
  }
  function confirmDeleteExpense(expense: Expense) {
    if (saveOperation.current || expense.paidBy !== active) return;
    const body = expense.shared ? 'Se eliminará para los dos y se recalculará el balance.' : 'Se quitará de tus gastos personales.';
    Alert.alert('¿Eliminar gasto?', body, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: () => {
        const expenses = data.expenses.filter(item => item.id !== expense.id);
        void saveMovement({ kind: 'delete-expense', id: expense.id }, { ...data, expenses }, 'Gasto eliminado');
      } },
    ]);
  }
  function closeMovement() {
    if (saveOperation.current) return;
    if (editingMovement && selectedMovement) openMovement(selectedMovement);
    else closeForm();
  }
  function reviseOtherMovement(movement: OtherMovement, remove: boolean) {
    if (movementOwner(movement) !== active || saveOperation.current) return;
    const next = reviseMovement(data, movement, remove);
    if (movement.kind === 'saving') {
      const { account, currency: walletCurrency } = movement.entry;
      if (getSavingsBalance(next, account, active, walletCurrency) < 0) {
        return Alert.alert('Saldo insuficiente', 'El cambio dejaría el ahorro con saldo negativo. Revisá los retiros de esa cuenta.');
      }
    }
    const afterSave = remove ? closeForm : () => {
      if (movement.kind === 'income') setMonth(movement.entry.date.slice(0, 7));
      openMovement(movement);
    };
    void saveMovement({ kind: remove ? 'delete-movement' : 'edit-movement', movement }, next,
      remove ? 'Registro eliminado' : 'Registro actualizado', afterSave);
  }
  function confirmDeleteMovement(movement: OtherMovement) {
    const title = movement.kind === 'saving' ? '¿Eliminar movimiento de ahorro?'
      : movement.kind === 'income' ? '¿Eliminar ingreso?'
      : movement.kind === 'debt' ? '¿Eliminar deuda registrada?' : '¿Eliminar pago de deuda?';
    Alert.alert(title, 'Se recalcularán los saldos que dependen de este registro.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: () => reviseOtherMovement(movement, true) },
    ]);
  }
  const addIncome = (entry: NewIncome) => {
    if (editingMovement && selectedMovement?.kind === 'income') {
      return reviseOtherMovement({ kind: 'income', entry: { ...selectedMovement.entry, ...entry } }, false);
    }
    const income = { ...entry, id: makeId(), owner: active };
    void saveMovement({ kind: 'income', entry }, { ...data, incomes: [income, ...data.incomes] }, 'Ingreso registrado');
  };
  const addTransfer = (entry: NewTransfer) => {
    if (editingMovement && selectedMovement?.kind === 'transfer') {
      return reviseOtherMovement({ kind: 'transfer', entry: { ...selectedMovement.entry, ...entry } }, false);
    }
    const net = entry.currency === 'USD' ? dollarBalance.net : balance.net;
    if (!linked || entry.amount > -net) return;
    const transfer = { ...entry, id: makeId(), from: active, to: balance.partner };
    void saveMovement({ kind: 'transfer', entry }, { ...data, transfers: [transfer, ...data.transfers] }, 'Pago registrado');
  };
  const addDebt = (entry: NewDebt) => {
    if (editingMovement && selectedMovement?.kind === 'debt') {
      return reviseOtherMovement({ kind: 'debt', entry: { ...selectedMovement.entry, ...entry } }, false);
    }
    if (!linked) return;
    const debt = { ...entry, id: makeId(), from: balance.partner, to: active, recordedBy: active };
    void saveMovement({ kind: 'debt', entry }, { ...data, debts: [debt, ...(data.debts ?? [])] }, 'Deuda registrada');
  };
  const addSaving = (entry: NewSaving) => {
    if (editingMovement && selectedMovement?.kind === 'saving') {
      return reviseOtherMovement({ kind: 'saving', entry: { ...selectedMovement.entry, ...entry } }, false);
    }
    if (savingFormAccount === 'shared' && !linked) return;
    const movement = { ...entry, account: savingFormAccount };
    const saved = { ...movement, id: makeId(), owner: active, createdAt: new Date().toISOString() };
    void saveMovement({ kind: 'saving', entry: movement }, { ...data, savings: [saved, ...data.savings] }, entry.kind === 'deposit' ? 'Aporte guardado' : 'Retiro guardado');
  };
  function saveDueDate(draft: DueDateDraft) {
    if (dueModal?.type !== 'save' || (dueModal.id && !dueDateBeingEdited)) return;
    const id = dueModal.id;
    const dueDates = id
      ? allDueDates.map(item => item.id === id ? {
        ...item, ...draft, scheduledDay: item.date === draft.date ? item.scheduledDay : undefined,
      } : item)
      : [{ ...draft, id: makeId(), owner: active, paidOn: null }, ...allDueDates];
    void saveMovement({ kind: 'due-date', action: { type: 'save', id, draft } }, { ...data, dueDates },
      id ? 'Vencimiento actualizado' : 'Vencimiento creado', () => {
        setDueMonth(monthKey(draft.date));
        closeForm();
      });
  }
  function toggleDueDate(item: DueDate) {
    if (item.owner !== active) return;
    if (!item.paidOn) {
      if (dueDatePaymentsEnabled) {
        setDueModal({ type: 'pay', id: item.id });
      } else {
        const date = dateInput();
        const dueDates = allDueDates.map(entry => entry.id === item.id ? { ...entry, paidOn: date } : entry);
        void saveMovement({ kind: 'due-date', action: { type: 'paid', id: item.id, date } },
          { ...data, dueDates }, 'Marcado como pagado');
      }
      return;
    }
    Alert.alert('¿Volver a pendiente?', activePaymentExpense(item)
      ? 'El registro del pago seguirá en Gastos.'
      : item.title, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Volver a pendiente', onPress: () => {
        const dueDates = allDueDates.map(entry => entry.id === item.id ? { ...entry, paidOn: null } : entry);
        void saveMovement({ kind: 'due-date', action: { type: 'paid', id: item.id, date: null } },
          { ...data, dueDates }, 'Marcado como pendiente');
      } },
    ]);
  }
  function payDueDate(payment: DueDatePayment) {
    const item = dueModal?.type === 'pay' ? selectedDueDate : undefined;
    if (!item || item.paidOn || (payment.expense && activePaymentExpense(item))) return;
    const expenses: Expense[] = [];
    if (payment.expense) {
      const { total, sharedAmount } = payment.expense;
      if (sharedAmount > 0 && !linked) return;
      const base = {
        category: item.category ?? 'otros' as const, paidBy: active, currency: item.currency,
        date: payment.date, description: item.title, createdAt: new Date().toISOString(),
      };
      if (total > sharedAmount) expenses.push({ ...base, id: makeId(), shared: false, amount: total - sharedAmount });
      if (sharedAmount > 0) expenses.push({ ...base, id: makeId(), shared: true, amount: sharedAmount });
    }
    const dueDates = allDueDates.map(entry => entry.id === item.id ? {
      ...entry, paidOn: payment.date,
      paymentExpenseIds: expenses.length ? expenses.map(expense => expense.id) : entry.paymentExpenseIds,
    } : entry);
    void saveMovement({ kind: 'due-date', action: { type: 'pay', id: item.id, ...payment } },
      { ...data, dueDates, expenses: [...expenses, ...data.expenses] },
      expenses.length ? 'Pago registrado en Gastos' : 'Marcado como pagado');
  }
  function requestDeleteDueDate(item: DueDate) {
    if (item.owner !== active || saveOperation.current) return;
    setDueDeleteId(item.id);
  }
  function cancelDueDelete() {
    if (!saveOperation.current) setDueDeleteId(null);
  }
  function confirmDueDelete() {
    if (!dueDateToDelete) return;
    const dueDates = allDueDates.filter(item => item.id !== dueDateToDelete.id);
    const afterSave = dueModal?.type === 'copy' ? cancelDueDelete : closeForm;
    void saveMovement({ kind: 'due-date', action: { type: 'delete', id: dueDateToDelete.id } },
      { ...data, dueDates }, 'Vencimiento eliminado', afterSave);
  }
  function copyDueDates(ids: string[], targetMonth: string, repeatMonthly: boolean) {
    const selected = dueDatesToCopy(ownDueDates, targetMonth).filter(item => ids.includes(item.id));
    if (!selected.length) return;
    if (repeatMonthly) {
      const schedules: DueDateSchedule[] = selected.map(item => ({
        id: makeId(), sourceId: item.id, owner: active, startsMonth: targetMonth,
        scheduledDay: item.scheduledDay ?? Number(item.date.slice(8, 10)),
        template: {
          title: item.title, date: item.date, amount: item.amount, currency: item.currency, category: item.category,
          paymentWindowDays: item.paymentWindowDays, remindDaily: item.remindDaily,
        },
      }));
      const bySource = new Map(schedules.map(schedule => [schedule.sourceId, schedule.id]));
      const originals = allDueDates.map(item => {
        const scheduleId = bySource.get(item.id);
        return scheduleId ? { ...item, scheduleId, repeatsMonthly: true } : item;
      });
      const generated = generateDueDateOccurrences([...schedules, ...(data.dueDateSchedules ?? [])], active, targetMonth, makeId);
      const change: DueDateChange = { kind: 'due-date', action: { type: 'copy', month: targetMonth, ids: selected.map(item => item.id), repeatMonthly: true } };
      void saveMovement(change, {
        ...data, dueDates: [...generated.dueDates, ...originals], dueDateSchedules: generated.schedules,
      }, 'Repetición mensual activada', () => {
        setDueMonth(targetMonth);
        closeForm();
      });
      return;
    }
    const copies = selected.map(item => ({
      ...item, id: makeId(), date: moveDueDateToMonth(item.date, targetMonth, item.scheduledDay),
      scheduledDay: item.scheduledDay ?? Number(item.date.slice(8, 10)),
      scheduleId: undefined, repeatsMonthly: false,
      paidOn: null, paymentExpenseIds: [], copiedFrom: item.id, copiedMonth: targetMonth,
    }));
    const change: DueDateChange = { kind: 'due-date', action: { type: 'copy', month: targetMonth, ids: selected.map(item => item.id) } };
    void saveMovement(change, { ...data, dueDates: [...copies, ...allDueDates] },
      copies.length === 1 ? 'Vencimiento copiado' : 'Vencimientos copiados', () => {
        setDueMonth(targetMonth);
        closeForm();
      });
  }
  function stopDueDateRecurrence(item: DueDate) {
    if (item.owner !== active || !item.scheduleId || !item.repeatsMonthly) return;
    const dueDateSchedules = (data.dueDateSchedules ?? []).filter(schedule => schedule.id !== item.scheduleId);
    const dueDates = allDueDates.map(entry => entry.scheduleId === item.scheduleId ? { ...entry, repeatsMonthly: false } : entry);
    void saveMovement({ kind: 'due-date', action: { type: 'stop-recurrence', id: item.id } },
      { ...data, dueDates, dueDateSchedules }, 'Repetición mensual desactivada', () => {});
  }
  const reset = () => Alert.alert('Reiniciar la demo', 'Se reemplazarán los cambios por los datos de ejemplo.', [
    { text: 'Cancelar', style: 'cancel' },
    { text: 'Reiniciar', style: 'destructive', onPress: () => { void resetDemoData().then((next) => { setDemoData(next); announce('Demo restablecida'); }); } },
  ]);

  const title: Record<Tab, string> = {
    gastos: 'Gastos', vencimientos: 'Vencimientos', ahorros: 'Ahorros', analisis: 'Análisis',
  };
  if (!loaded) return <SafeAreaView style={styles.loading}><StatusBar style="dark"/><Text style={styles.brand}>duo<Text style={styles.brandDot}>·</Text></Text><Text style={styles.muted}>Preparando la demo…</Text></SafeAreaView>;

  const accountControls = cloud ? <Pressable accessibilityRole="button" accessibilityLabel={`Mi cuenta, ${people.adri}`}
    onPress={cloud.openAccount} style={[styles.profileItem, styles.profileItemActive, styles.accountButton]}>
    <Text style={styles.avatar}>{people.adri[0].toUpperCase()}</Text>
    <Text numberOfLines={1} style={[styles.profileName, styles.profileNameActive, styles.accountName]}>{people.adri}</Text>
    <Text style={styles.profileName}>›</Text>
  </Pressable> : <View style={styles.demoControls}>
    {onExitDemo && <Pressable accessibilityRole="button" accessibilityLabel="Salir de la demo" onPress={onExitDemo}
      style={styles.accountButton}><Text style={styles.homeBalanceLinkText}>Salir</Text></Pressable>}
    <Pressable accessibilityRole="button" accessibilityLabel="Reiniciar la demo" onPress={reset} style={styles.resetButton}><Text style={styles.resetText}>↺</Text></Pressable>
    <View style={styles.profileToggle}>{(['adri', 'mel'] as PersonId[]).map(person => <Pressable key={person}
      accessibilityRole="button" accessibilityState={{ selected: active === person }} onPress={() => setActive(person)}
      style={[styles.profileItem, active === person && styles.profileItemActive]}>
      <Text style={[styles.avatar, person === 'mel' && styles.avatarMel]}>{people[person][0]}</Text>
      <Text numberOfLines={1} style={[styles.profileName, active === person && styles.profileNameActive]}>{people[person]}</Text>
    </Pressable>)}</View>
  </View>;

  return <PeopleContext.Provider value={people}><SafeAreaView style={styles.app} edges={['top', 'left', 'right']}>
    <StatusBar style="dark"/>
    <View style={styles.content} {...(tab === 'gastos' ? expenseSwipe.panHandlers : undefined)}>
      <ScrollView key={tab} style={styles.content} contentContainerStyle={[styles.contentInner, tab === 'gastos' && styles.expenseScrollContent]} keyboardShouldPersistTaps="handled"
        refreshControl={cloud ? <RefreshControl refreshing={refreshing} onRefresh={() => void refreshDashboard()}/> : undefined}>
        <TabHeading title={title[tab]} photo={coverUri} busy={coverBusy} accountControls={accountControls}
          onPick={() => void updateCover(false)} onRemove={() => void updateCover(true)}/>
        <View style={styles.tabContent}>
          {!!cloud?.syncError && <Pressable accessibilityRole="button" onPress={() => void refreshDashboard()} style={styles.syncBanner}>
            <Text style={styles.homeBalanceLinkText}>{cloud.syncError}</Text>
          </Pressable>}
          {tab === 'gastos' && <ExpensesScreen key={ownerId ?? active} active={active} data={data} filter={expenseFilter} setFilter={setExpenseFilter}
            onSearchInteract={() => { balanceHandlesSwipe.current = true; }}
            onExpensePress={openExpense} onMovementPress={openMovement} sharedBalance={<SharedBalance
              active={active} partner={balance.partner} net={balance.net} usdNet={dollarBalance.net}
              transfers={data.transfers} debts={data.debts} onMovementPress={openMovement}
              onCurrencySwipeStart={() => { balanceHandlesSwipe.current = true; }}
              onSettle={selectedCurrency => { setTransferCurrency(selectedCurrency); setForm('transfer'); }}
              onAddDebt={() => setForm('debt')} onLink={linked ? undefined : cloud?.openAccount}
            />}/>}
          {tab === 'vencimientos' && <DueDatesScreen month={dueMonth} setMonth={setDueMonth} dueDates={ownDueDates} saving={saving}
            onNew={() => setDueModal({ type: 'save' })} onEdit={item => setDueModal({ type: 'save', id: item.id })}
            onToggle={toggleDueDate} onDelete={requestDeleteDueDate}
            onCopyPrevious={previousCopyCandidates.length ? () => setDueModal({ type: 'copy' }) : undefined}/>}
          {tab === 'ahorros' && <SavingsScreen data={data} active={active} linked={linked}
            interestRate={(cloud ? cloud.personalInterest : data.personalInterest?.[active])?.annualPercent ?? 0} onInterestChange={updatePersonalInterest}
            sharedInterestRate={(cloud ? cloud.sharedInterest : data.sharedInterest)?.annualPercent ?? 0} onSharedInterestChange={updateSharedInterest}
            account={linked ? savingAccount : 'personal'} setAccount={setSavingAccount}
            onAdd={account => { setSavingFormAccount(account); setForm('saving'); }} onMovementPress={openMovement}/>}
          {tab === 'analisis' && <AnalysisScreen month={month} setMonth={setMonth} mode={analysisMode} setMode={setAnalysisMode}
            expenses={data.expenses} active={active} cash={getMonthlyCash(data, active, month)}
            cashInterestRate={(cloud ? cloud.cashInterest : data.cashInterest?.[active])?.annualPercent ?? 0}
            cashInterestBalance={getMonthlyCash(data, active, interestBusinessDay().slice(0, 7), interestBusinessDay()).remaining} onCashInterestChange={updateCashInterest}
            onIncome={() => setForm('income')} onMovementPress={openMovement}/>}
        </View>
      </ScrollView>
      {tab === 'gastos' && <View pointerEvents="box-none" style={styles.expenseActions}>
        <MotionButton accessibilityRole="button" onPress={newExpense} style={[styles.expenseAdd, styles.roundedCreateAction]}>
          <Text style={styles.expenseAddText}>＋  Agregar gasto</Text>
        </MotionButton>
      </View>}
    </View>
    <MainTabBar activeTab={tab} onSelect={setTab}/>
    {!!notice && <View style={[styles.toast, { bottom: navigationInset + (tab === 'gastos' ? 132 : 72) }]}><Text style={styles.toastText}>{notice}</Text></View>}
    {(dueModal || dueDateToDelete) && <DueDateModal mode={dueModal?.type} month={dueMonth} item={selectedDueDate}
      candidates={previousCopyCandidates}
      saving={saving} onClose={closeForm} onSave={saveDueDate} onDelete={requestDeleteDueDate}
      deletingItem={dueDateToDelete} onCancelDelete={cancelDueDelete} onConfirmDelete={confirmDueDelete}
      categoriesEnabled={dueDatePaymentsEnabled} sharedAllowed={linked}
      hasExpense={!!selectedDueDate && activePaymentExpense(selectedDueDate)} onPay={payDueDate}
      repeatAllowed={dueDateRecurrenceEnabled}
      onCopy={(ids, repeatMonthly) => copyDueDates(ids, dueMonth, repeatMonthly)}
      onStopRecurrence={stopDueDateRecurrence}/>}
    {expenseModalOpen && <SafeAreaModal visible presentationStyle="fullScreen" animationType="slide" onRequestClose={closeExpense}>
      {expenseView?.mode === 'new' || editingExpense
        ? <ExpenseForm key={selectedExpense?.id ?? 'new'} expense={selectedExpense} onSave={editingExpense ? editExpense : addExpense}
            onClose={closeExpense} sharedAllowed={linked} initiallyShared={!cloud} saving={saving} receiptsEnabled={!!cloud} onReceiptBusy={trackReceiptOperation}/>
        : selectedExpense && <ExpenseDetails key={selectedExpense.id} expense={selectedExpense} active={active} saving={saving} onClose={closeExpense}
            receiptsEnabled={!!cloud} onReceiptBusy={trackReceiptOperation}
            onEdit={() => setExpenseView({ mode: 'edit', id: selectedExpense.id })}
            onDelete={() => confirmDeleteExpense(selectedExpense)}/>}
    </SafeAreaModal>}
    {!expenseModalOpen && <MovementModal form={form} net={balance.net} usdNet={dollarBalance.net} transferCurrency={transferCurrency}
        partner={people[balance.partner]} account={savingFormAccount} saving={saving}
        active={active} data={data} month={month} onClose={closeMovement}
        movement={selectedMovement} editing={editingMovement}
        onEdit={movement => setMovementView({ kind: movement.kind, id: movement.entry.id, editing: true })}
        onDelete={confirmDeleteMovement}
        onTransfer={addTransfer} onDebt={addDebt} onSaving={addSaving} onIncome={addIncome}/>}
  </SafeAreaView></PeopleContext.Provider>;
}

function TabHeading({ title, photo, busy, accountControls, onPick, onRemove }: {
  title: string;
  photo: string | null;
  busy: boolean;
  accountControls: ReactNode;
  onPick: () => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (!photo) {
    return <View style={[styles.pageHeading, styles.pageHeadingPlain]}>
      <View style={styles.pageHeadingText}>
        <Text accessibilityRole="header" style={styles.pageTitle}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Agregar foto de portada"
          disabled={busy} onPress={onPick} style={styles.coverAdd}>
          <Text style={styles.homeBalanceLinkText}>{busy ? 'Cargando…' : '＋ Agregar foto'}</Text>
        </Pressable>
      </View>
      {accountControls}
    </View>;
  }
  return <View style={styles.coverFrame}>
    <Image accessible={false} source={{ uri: photo }} resizeMode="cover" style={styles.coverImage}/>
    <View style={styles.coverCaption}>
      <Text accessibilityRole="header" style={[styles.pageTitle, styles.pageTitleCover]}>{title}</Text>
    </View>
    {menuOpen && <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={() => setMenuOpen(false)}/>}
    <View style={styles.coverToolbar} pointerEvents="box-none">
      <Pressable accessibilityRole="button" accessibilityLabel="Opciones de portada"
        accessibilityState={{ expanded: menuOpen, disabled: busy }}
        disabled={busy} onPress={() => setMenuOpen(value => !value)} style={styles.coverTrigger}>
        <View style={styles.coverDots}><Text style={styles.coverDotsText}>⋯</Text></View>
      </Pressable>
      {accountControls}
    </View>
    {menuOpen && <View style={styles.coverMenu}>
      <Pressable accessibilityRole="button" onPress={() => { setMenuOpen(false); onPick(); }} style={styles.coverMenuItem}>
        <Text style={styles.coverMenuText}>Cambiar foto</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => { setMenuOpen(false); onRemove(); }} style={styles.coverMenuItem}>
        <Text style={styles.coverMenuText}>Quitar foto</Text>
      </Pressable>
    </View>}
  </View>;
}

function SharedBalance({ active, partner, net, usdNet, transfers, debts, onMovementPress, onCurrencySwipeStart, onSettle, onAddDebt, onLink }: {
  active: PersonId;
  partner: PersonId;
  net: number;
  usdNet: number;
  transfers: Transfer[];
  debts?: Debt[];
  onMovementPress: OpenMovement;
  onCurrencySwipeStart: () => void;
  onSettle: (currency: Currency) => void;
  onAddDebt: () => void;
  onLink?: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [balancePage, setBalancePage] = useState(0);
  const people = useContext(PeopleContext);
  const balances = [['ARS', 'Pesos', net], ['USD', 'Dólares', usdNet]] as const;

  if (onLink) {
    return <View style={[styles.homeBalance, styles.sharedBalanceSection]}>
      <Pressable accessibilityRole="button" onPress={onLink} style={styles.homeBalanceLink}>
        <Text style={styles.homeBalanceLinkText}>Vincular otra cuenta ›</Text>
      </Pressable>
    </View>;
  }

  return <View style={styles.sharedBalanceSection}>
    <View onStartShouldSetResponderCapture={() => {
      onCurrencySwipeStart();
      return false;
    }}>
      <SwipePages page={balancePage} onPageChange={setBalancePage}
        pages={balances.map(([currency, label, amount]) => {
          const status = amount === 0 ? 'Están a mano' : amount < 0 ? `Le debés a ${people[partner]}` : `${people[partner]} te debe`;
          const isDollars = currency === 'USD';
          return { key: currency, content: <View style={styles.homeBalance}>
              <View style={styles.balanceSummary}>
                <Label>{label.toUpperCase()}</Label>
                <Text style={styles.homeBalanceStatus}>{status}</Text>
                {amount !== 0 && <Text style={[styles.homeBalanceAmount, amount < 0 && styles.homeAmountOwed]}>{money(amount, currency)}</Text>}
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={isDollars ? 'Ver saldo en pesos' : 'Ver saldo en dólares'}
                onPress={() => setBalancePage(isDollars ? 0 : 1)} style={styles.balanceSwitch}>
                <Text style={styles.balanceSwitchText}>{isDollars ? '‹' : '›'}</Text>
              </Pressable>
              {(amount < 0 || isDollars) && <View style={styles.cardActions}>
                {amount < 0 && <MotionButton accessibilityRole="button" accessibilityLabel={`Liquidar deuda en ${label.toLowerCase()}`}
                  onPress={() => onSettle(currency)} style={styles.smallPrimaryButton}>
                  <Text style={styles.smallPrimaryButtonText}>Liquidar deuda</Text>
                </MotionButton>}
                {isDollars && <MotionButton accessibilityRole="button" onPress={onAddDebt} style={styles.homeBalanceLink}>
                  <Text style={styles.homeBalanceLinkText}>Registrar deuda</Text>
                </MotionButton>}
              </View>}
            </View> };
        })}/>
    </View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: historyOpen }}
      onPress={() => setHistoryOpen(value => !value)} style={styles.homeBalanceLink}>
      <Text style={styles.homeBalanceLinkText}>{historyOpen ? 'Ocultar historial' : 'Historial de deudas y pagos'}</Text>
    </Pressable>
    {historyOpen && <SharedHistory transfers={transfers} debts={debts} active={active} onMovementPress={onMovementPress}/>}
  </View>;
}

function SectionHeader({ overline, title }: { overline: string; title: string }) {
  return <View style={styles.sectionHeader}><Label>{overline}</Label><Text style={styles.sectionTitle}>{title}</Text></View>;
}

function ExpenseRow({ expense, active, onPress, showFullDescription = false }: {
  expense: Expense;
  active: PersonId;
  onPress: () => void;
  showFullDescription?: boolean;
}) {
  const people = useContext(PeopleContext);
  const cat = CATEGORIES.find((c) => c.id === expense.category)!;
  const own = expense.paidBy === active;
  const payerColor = own ? styles.expensePaidByYou : styles.expensePaidByPartner;
  const currency = expense.currency ?? 'ARS';
  const share = `${own ? 'Prestaste' : 'Pediste'} ${amountFormat.format(expense.amount / 2)} ${currency}`;
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.movementRow, pressed && styles.expenseRowPressed]}>
    <CategoryMark category={expense.category}/>
    <View style={styles.movementInfo}>
      <Text numberOfLines={showFullDescription ? undefined : 1} style={styles.movementTitle}>{expense.description || cat.label}</Text>
      <Text style={[styles.movementSub, expense.shared && payerColor]}>{expense.shared ? share : `${cat.label} · Personal`}</Text>
    </View>
    <View style={styles.movementRight}>
      <Text style={[styles.movementAmount, payerColor]}>{money(expense.amount, expense.currency)}</Text>
      <Text style={[styles.movementSub, payerColor]}>{own ? 'Pagaste vos' : `Pagó ${people[expense.paidBy]}`}</Text>
    </View>
    <Text style={styles.movementDate}>{formatDate(expense.date)}</Text>
  </Pressable>;
}

function PersonalSavingsRow({ move, onPress }: { move: SavingMove; onPress: () => void }) {
  const fromMonthlyCash = move.currency === 'ARS' && !move.excludeFromMonthlyCash;
  return <Pressable accessibilityRole="button" onPress={onPress}
    style={({ pressed }) => [styles.movementRow, pressed && styles.expenseRowPressed]}>
    <View style={[styles.transferMark, fromMonthlyCash ? styles.sentMark : styles.receivedMark]}><Text>↗</Text></View>
    <View style={styles.movementInfo}>
      <Text style={styles.movementTitle}>{fromMonthlyCash ? 'Pasado a ahorro personal' : 'Aporte al ahorro personal'}</Text>
      {!!move.note && <Text numberOfLines={1} style={styles.homeExpensePayer}>{move.note}</Text>}
    </View>
    <Text style={styles.movementAmount}>{fromMonthlyCash ? '−' : '+'} {money(move.amount, move.currency)}</Text>
    <Text style={styles.movementDate}>{formatDate(move.date)}</Text>
  </Pressable>;
}

function ExpensesScreen({ active, data, filter, setFilter, onExpensePress, onMovementPress, sharedBalance, onSearchInteract }: {
  active: PersonId; data: DuoData; filter: ExpenseFilter; setFilter: (filter: ExpenseFilter) => void;
  onExpensePress: (id: string) => void; onMovementPress: OpenMovement;
  sharedBalance: ReactNode;
  onSearchInteract: () => void;
}) {
  const people = useContext(PeopleContext);
  const [search, setSearch] = useState<ExpenseSearch>(EMPTY_EXPENSE_SEARCH);
  const [searchOpen, setSearchOpen] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const index = useMemo(() => buildExpenseSearchIndex(data, active, people), [data, active, people]);
  const activities = useMemo(() => {
    const matched = filterExpenseSearch(index, deferredSearch);
    return expenseFilters.map(([option]) => matched.filter(item => option === 'all'
      || (item.kind === 'expense' ? item.entry.shared === (option === 'shared') : option === 'personal')));
  }, [index, deferredSearch]);
  const searching = hasExpenseSearch(search);
  const pending = deferredSearch !== search;
  const page = expenseFilters.findIndex(([option]) => option === filter);
  return <>
    <View style={[styles.filterRow, styles.expenseFilterRow]}>
      {expenseFilters.map(([option, label]) => <Pill compact key={option} active={filter === option} onPress={() => setFilter(option)}>{label}</Pill>)}
      <ExpenseSearchToggle expanded={searchOpen} active={searching} onInteract={onSearchInteract}
        onPress={() => { if (searchOpen) Keyboard.dismiss(); setSearchOpen(open => !open); }}/>
    </View>
    {searchOpen && <ExpenseSearchBar value={search} onChange={setSearch} names={people} onInteract={onSearchInteract} autoFocus/>}
    {filter === 'shared' && sharedBalance}
    {searching && <ExpenseSearchSummary count={activities[page].length} pending={pending} onClear={() => setSearch(EMPTY_EXPENSE_SEARCH)}/>}
    <SwipePages page={page}
      pages={expenseFilters.map(([option], pageIndex) => ({
        key: option,
        content: <View style={styles.listCard}>
          {activities[pageIndex].length ? activities[pageIndex].map(item => item.kind === 'expense'
            ? <ExpenseRow key={`expense-${item.entry.id}`} expense={item.entry} active={active} showFullDescription={option === 'shared'}
                onPress={() => onExpensePress(item.entry.id)}/>
            : <PersonalSavingsRow key={`saving-${item.entry.id}`} move={item.entry} onPress={() => onMovementPress({ kind: 'saving', entry: item.entry })}/>)
            : <EmptyState title={pending ? 'Buscando…' : searching ? 'No encontramos registros' : 'Todavía no hay gastos'}
                body={searching ? 'Probá otro texto o quitá algún filtro.' : 'Cuando anotes uno, va a aparecer acá.'}/>}
        </View>,
      }))}/>
  </>;
}

function SharedHistory({ transfers, debts = [], active, onMovementPress }: {
  transfers: Transfer[]; debts?: Debt[]; active: PersonId; onMovementPress: OpenMovement;
}) {
  const people = useContext(PeopleContext);
  const sorted = [
    ...transfers.map(entry => ({ kind: 'transfer' as const, entry })),
    ...debts.map(entry => ({ kind: 'debt' as const, entry })),
  ].sort((a, b) => b.entry.date.localeCompare(a.entry.date));
  if (!sorted.length) return <Text style={styles.historyEmpty}>Todavía no hay deudas registradas ni pagos.</Text>;

  return <View style={[styles.listCard, styles.homeTransferList]}>
    {sorted.map(movement => {
      const { entry } = movement;
      const isDebt = movement.kind === 'debt';
      const received = entry.to === active;
      const direction = isDebt ? (received ? `Deuda de ${people[entry.from]}` : `Deuda con ${people[entry.to]}`)
        : (received ? `${people[entry.from]} te pagó` : `Le pagaste a ${people[entry.to]}`);
      return <Pressable key={entry.id} accessibilityRole="button" onPress={() => onMovementPress(movement)}
        style={({ pressed }) => [styles.movementRow, pressed && styles.expenseRowPressed]}>
        <View style={[styles.transferMark, received ? styles.receivedMark : styles.sentMark]}><Text>{isDebt ? '↔' : received ? '↓' : '↑'}</Text></View>
        <View style={styles.movementInfo}>
          <Text style={styles.movementTitle}>{entry.note || (isDebt ? 'Deuda registrada' : 'Liquidación de deuda')}</Text>
          <Text style={styles.homeExpensePayer}>{direction} · {formatDate(entry.date)}</Text>
        </View>
        <Text style={styles.movementAmount}>{money(entry.amount, movement.kind === 'debt' ? 'USD' : movement.entry.currency)}</Text>
      </Pressable>;
    })}
  </View>;
}

function SavingsScreen({ data, active, linked, account, setAccount, onAdd, onMovementPress, interestRate, onInterestChange, sharedInterestRate, onSharedInterestChange }: {
  data: DuoData; active: PersonId; linked: boolean; account: SavingMove['account'];
  setAccount: (account: SavingMove['account']) => void;
  onAdd: (account: SavingMove['account']) => void; onMovementPress: OpenMovement;
  interestRate: number; onInterestChange: (annualPercent: number) => Promise<void>;
  sharedInterestRate: number; onSharedInterestChange: (annualPercent: number) => Promise<void>;
}) {
  const people = useContext(PeopleContext);
  const accounts: SavingMove['account'][] = linked ? ['personal', 'shared'] : ['personal'];
  const movements = data.savings.filter(move => move.account === account && (account === 'shared' || move.owner === active))
    .sort((a, b) => b.date.localeCompare(a.date));
  return <>
    <View style={styles.selectorRow}>
      <View style={styles.pillGroup}>
        <Pill active={account === 'personal'} onPress={() => setAccount('personal')}>Personal</Pill>
        {linked && <Pill active={account === 'shared'} onPress={() => setAccount('shared')}>Compartido</Pill>}
      </View>
    </View>
    <SwipePages page={accounts.indexOf(account)} onPageChange={index => setAccount(accounts[index])}
      pages={accounts.map(option => ({
        key: option,
        content: <View style={[styles.savingsCard, option === 'shared' && styles.savingsCardShared]}>
          <Label>{option === 'personal' ? `AHORRO PERSONAL DE ${people[active].toUpperCase()}` : 'AHORRO DE LOS DOS'}</Label>
          <View style={styles.savingsBalances}>
            {currencyPages.map(currency => <View key={currency} style={currency === 'USD' && styles.savingsDollarTotal}>
              <View style={styles.interestBalanceHeading}><Text style={styles.currencyBalanceLabel}>{currency === 'ARS' ? 'Pesos' : 'Dólares'}</Text>
                {currency === 'ARS' && <PersonalInterestControl key={`${active}:${option}`} shared={option === 'shared'} rate={option === 'shared' ? sharedInterestRate : interestRate}
                  balance={getSavingsBalance(data, option, active, currency)} onSave={option === 'shared' ? onSharedInterestChange : onInterestChange}/>}
              </View>
              <Text style={[styles.savingsAmount, currency === 'USD' && styles.savingsDollarAmount]}>
                {money(getSavingsBalance(data, option, active, currency), currency)}
              </Text>
              {currency === 'ARS' && (option === 'shared' ? sharedInterestRate : interestRate) > 0 && <Text style={styles.movementSub}>
                + {money(dailyPersonalInterest(getSavingsBalance(data, option, active, currency), option === 'shared' ? sharedInterestRate : interestRate))} estimados por día
              </Text>}
            </View>)}
          </View>
          <ActionButton title="Registrar movimiento" onPress={() => onAdd(option)} light/>
        </View>,
      }))}/>
    <SectionHeader overline="APORTES Y RETIROS" title="Historial"/>
    <View style={styles.listCard}>{movements.length ? movements.map((move) => {
      const canEdit = move.owner === active;
      return <Pressable key={move.id} accessibilityRole="button"
        accessibilityHint={canEdit ? 'Abre el detalle con opciones para editar o eliminar' : undefined}
        onPress={() => onMovementPress({ kind: 'saving', entry: move })}
        style={({ pressed }) => [
          styles.movementRow, canEdit && styles.editableRow,
          pressed && (canEdit ? styles.editableRowPressed : styles.expenseRowPressed),
        ]}>
        <View style={[styles.transferMark, move.kind === 'deposit' ? styles.receivedMark : styles.sentMark]}>
          <Text>{move.kind === 'deposit' ? '↗' : '↘'}</Text>
        </View>
        <View style={styles.movementInfo}>
          <Text style={styles.movementTitle}>{move.note || (move.kind === 'deposit' ? 'Aporte' : 'Retiro')}</Text>
          <Text style={styles.movementSub}>{move.account === 'shared' ? `Compartido · ${move.interestOn ? 'Automático' : people[move.owner]}` : 'Personal'} · {formatDate(move.date)}</Text>
          {move.excludeFromMonthlyCash && <Text style={styles.movementSub}>Sin descontar del mes</Text>}
        </View>
        <Text style={[styles.movementAmount, move.kind === 'withdraw' && styles.withdrawAmount]}>
          {move.kind === 'withdraw' ? '−' : '+'} {money(move.amount, move.currency)}
        </Text>
        {canEdit && <Text importantForAccessibility="no" style={styles.editableRowIcon}>✎</Text>}
      </Pressable>;
    }) : <EmptyState title="El primer paso suma" body="Registrá un aporte para empezar."/>}</View>
  </>;
}

function MonthSelector({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const months = [-1, 0, 1].map(offset => shiftMonth(month, offset));
  return <View style={styles.periodCard}>
    <MotionButton accessibilityRole="button" accessibilityLabel="Mes anterior"
      onPress={() => onChange(months[0])} style={styles.periodArrow}>
      <Text style={styles.periodArrowText}>‹</Text>
    </MotionButton>
    <View style={styles.periodPager}>
      <SwipePages page={1} resetKey={month} onPageChange={index => onChange(months[index])}
        pages={months.map((value, index) => ({
          key: String(index),
          content: <View accessible accessibilityLabel={formatMonth(value)} style={styles.periodPage}>
            <Text style={styles.periodMonth} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              {monthName(value)} {value.slice(0, 4)}
            </Text>
          </View>,
        }))}/>
    </View>
    <MotionButton accessibilityRole="button" accessibilityLabel="Mes siguiente"
      onPress={() => onChange(months[2])} style={styles.periodArrow}>
      <Text style={styles.periodArrowText}>›</Text>
    </MotionButton>
  </View>;
}

function DueDatesScreen({ month, setMonth, dueDates, saving, onNew, onEdit, onToggle, onDelete, onCopyPrevious }: {
  month: string; setMonth: (month: string) => void; dueDates: DueDate[]; saving: boolean;
  onNew: () => void; onEdit: (item: DueDate) => void; onToggle: (item: DueDate) => void;
  onDelete: (item: DueDate) => void; onCopyPrevious?: () => void;
}) {
  const [paidOpen, setPaidOpen] = useState(false);
  const [openDeleteId, setOpenDeleteId] = useState<string | null>(null);
  const today = dateInput();
  const showOlderPending = month === monthKey(today);
  const pending = dueDates.filter(item => !item.paidOn && (
    monthKey(item.date) === month || (showOlderPending && monthKey(item.date) < month)
  )).sort((first, second) => first.date.localeCompare(second.date));
  const paid = dueDates.filter(item => item.paidOn && monthKey(item.date) === month)
    .sort((first, second) => (second.paidOn ?? '').localeCompare(first.paidOn ?? ''));

  const row = (item: DueDate) => <DueDateSwipeRow key={item.id} item={item} open={openDeleteId === item.id}
    disabled={saving} onOpenChange={setOpenDeleteId} onDelete={onDelete}>
    <DueDateRow item={item} today={today} saving={saving} onEdit={() => onEdit(item)} onToggle={() => onToggle(item)}/>
  </DueDateSwipeRow>;
  return <>
    <MonthSelector month={month} onChange={next => { setOpenDeleteId(null); setMonth(next); }}/>
    <View style={styles.dueActions}>
      <MotionButton accessibilityRole="button" onPress={onNew} disabled={saving} style={[styles.smallPrimaryButton, styles.roundedCreateAction]}>
        <Text style={styles.smallPrimaryButtonText}>＋ Nuevo vencimiento</Text>
      </MotionButton>
    </View>
    {onCopyPrevious && <View style={styles.dueCopyActions}>
      <MotionButton accessibilityRole="button" onPress={onCopyPrevious} disabled={saving} style={styles.dueCopyButton}>
        <Text style={styles.homeBalanceLinkText}>Copiar del mes anterior</Text>
      </MotionButton>
    </View>}
    <Text accessibilityRole="header" style={styles.dueSectionTitle}>Pendientes · {pending.length}</Text>
    <View style={styles.listCard}>{pending.length
      ? pending.map(row)
      : <EmptyState title="Sin vencimientos pendientes" body={paid.length ? 'Estás al día para este mes.' : 'Agregá una cuenta y su fecha de pago.'}/>}
    </View>
    {paid.length > 0 && <>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: paidOpen }}
        onPress={() => setPaidOpen(value => !value)} style={styles.duePaidToggle}>
        <Text style={styles.sectionTitle}>Pagados · {paid.length}</Text>
        <Text style={styles.homeBalanceLinkText}>{paidOpen ? '⌃' : '⌄'}</Text>
      </Pressable>
      {paidOpen && <View style={styles.listCard}>{paid.map(row)}</View>}
    </>}
  </>;
}

const dueDeleteActionWidth = 100;

function DueDateSwipeRow({ item, open, disabled, onOpenChange, onDelete, children }: {
  item: DueDate; open: boolean; disabled: boolean; onOpenChange: (id: string | null) => void;
  onDelete: (item: DueDate) => void; children: ReactNode;
}) {
  const reduceMotion = useContext(ReduceMotionContext);
  const [translateX] = useState(() => new Animated.Value(0));
  const snap = useCallback((revealed: boolean) => {
    Animated.timing(translateX, {
      toValue: revealed ? dueDeleteActionWidth : 0,
      duration: reduceMotion ? 0 : 150, easing: Easing.out(Easing.cubic),
      useNativeDriver: true, isInteraction: false,
    }).start();
  }, [reduceMotion, translateX]);

  useEffect(() => {
    snap(open);
    return () => translateX.stopAnimation();
  }, [open, snap, translateX]);

  const swipe = useMemo(() => {
    let startX = 0;
    let startY = 0;
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: ({ nativeEvent }) => {
        startX = nativeEvent.pageX;
        startY = nativeEvent.pageY;
        return false;
      },
      onMoveShouldSetPanResponderCapture: (_, { dx, dy, numberActiveTouches }) =>
        !disabled && numberActiveTouches === 1 && (open ? dx < -12 : dx > 12) && Math.abs(dx) > Math.abs(dy) * 1.4,
      onPanResponderGrant: () => translateX.stopAnimation(),
      onPanResponderMove: ({ nativeEvent }) => {
        const offset = (open ? dueDeleteActionWidth : 0) + nativeEvent.pageX - startX;
        translateX.setValue(Math.max(0, Math.min(dueDeleteActionWidth, offset)));
      },
      onPanResponderRelease: ({ nativeEvent }) => {
        const dx = nativeEvent.pageX - startX;
        const dy = nativeEvent.pageY - startY;
        if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.4 && open !== (dx > 0)) {
          onOpenChange(dx > 0 ? item.id : null);
        } else snap(open);
      },
      onPanResponderTerminate: () => snap(open),
    });
  }, [disabled, item.id, onOpenChange, open, snap, translateX]);

  return <View style={styles.dueSwipeRow}>
    <Pressable style={styles.dueSwipeDelete} accessibilityRole="button"
      accessibilityLabel={`Eliminar ${item.title}`} accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      disabled={!open || disabled} onPress={() => onDelete(item)}>
      <Text style={styles.dueSwipeDeleteText}>Eliminar</Text>
    </Pressable>
    <Animated.View style={[styles.dueSwipeForeground, { transform: [{ translateX }] }]} {...swipe.panHandlers}>
      {children}
    </Animated.View>
  </View>;
}

function DueDateCheck({ checked, disabled, label, onPress }: {
  checked: boolean; disabled?: boolean; label: string; onPress: () => void;
}) {
  return <MotionButton accessibilityRole="checkbox" accessibilityLabel={label}
    accessibilityState={{ checked, disabled }} disabled={disabled} onPress={onPress} style={styles.dueCheckTarget}>
    <View style={[styles.dueCheck, checked && styles.dueCheckActive]}>
      {checked && <Text style={styles.dueCheckMark}>✓</Text>}
    </View>
  </MotionButton>;
}

function DueDateRow({ item, today, saving, onEdit, onToggle }: {
  item: DueDate; today: string; saving: boolean; onEdit: () => void; onToggle: () => void;
}) {
  const status = item.paidOn ? `Pagado el ${formatDate(item.paidOn)}`
    : item.date === today ? 'Vence hoy'
      : `${item.date < today ? 'Venció el' : 'Vence el'} ${formatDate(item.date)}`;
  const needsAttention = !item.paidOn && item.date <= today;
  const payableFrom = payableFromDate(item.date, item.paymentWindowDays);
  return <View style={[styles.movementRow, styles.dueRow]}>
    <DueDateCheck checked={!!item.paidOn} disabled={saving}
      label={`Marcar ${item.title} como ${item.paidOn ? 'pendiente' : 'pagado'}`} onPress={onToggle}/>
    <Pressable accessibilityRole="button" accessibilityHint="Abre la edición del vencimiento" onPress={onEdit}
      disabled={saving} style={({ pressed }) => [styles.dueRowDetails, pressed && styles.expenseRowPressed]}>
      <CategoryMark category={item.category ?? 'otros'} small/>
      <View style={styles.movementInfo}>
        <Text style={styles.movementTitle}>{item.title}</Text>
        <Text style={[styles.homeExpensePayer, needsAttention && styles.homeAmountOwed]}>{status}</Text>
        {!item.paidOn && payableFrom && payableFrom < item.date && <Text style={styles.movementSub}>
          Se puede pagar desde el {formatDate(payableFrom)}
        </Text>}
        {item.repeatsMonthly && <Text style={styles.movementSub}>Repite cada mes</Text>}
      </View>
      {item.amount !== null && <Text style={styles.movementAmount}>{money(item.amount, item.currency)}</Text>}
    </Pressable>
  </View>;
}

function DueDateModal({ mode, month, item, candidates, saving, categoriesEnabled, sharedAllowed,
  hasExpense, repeatAllowed, onClose, onSave, onPay, onCopy, onStopRecurrence, onDelete, deletingItem, onCancelDelete, onConfirmDelete }: {
  mode?: DueDateModalState['type']; month: string; item?: DueDate; candidates: DueDate[]; saving: boolean;
  categoriesEnabled: boolean; sharedAllowed: boolean; hasExpense: boolean; onPay: (payment: DueDatePayment) => void;
  repeatAllowed: boolean;
  onClose: () => void; onSave: (draft: DueDateDraft) => void; onDelete: (item: DueDate) => void;
  onCopy: (ids: string[], repeatMonthly: boolean) => void; onStopRecurrence: (item: DueDate) => void;
  deletingItem?: DueDate; onCancelDelete: () => void; onConfirmDelete: () => void;
}) {
  const isCreating = mode === 'save' && !item && !deletingItem;
  const dismiss = deletingItem ? onCancelDelete : onClose;
  const title = deletingItem ? '¿Eliminar vencimiento?' : mode === 'pay' ? '¿Ya lo pagaste?'
    : mode === 'copy' ? 'Copiar del mes anterior' : item ? 'Editar vencimiento' : 'Nuevo vencimiento';
  const header = <>
    <View style={styles.modalHandle}/>
    <View style={styles.modalHeading}>
      <Text accessibilityRole="header" style={styles.modalTitle}>{title}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={isCreating ? 'Cerrar nuevo vencimiento' : 'Cerrar'}
        onPress={dismiss} disabled={saving} style={isCreating ? styles.expenseClose : styles.modalClose}>
        <Text style={isCreating && styles.expenseCloseText}>×</Text>
      </Pressable>
    </View>
    {saving && <Text accessibilityLiveRegion="polite" style={styles.syncBanner}>Guardando…</Text>}
  </>;
  return <SafeAreaModal visible transparent animationType="slide" onRequestClose={dismiss}>
    <SafeAreaView style={styles.modalBackdrop}>
      {isCreating
        ? <DueDateForm month={month} categoriesEnabled={categoriesEnabled} onClose={onClose} onSave={onSave}
            createLayout={{ header, saving }}/>
        : <KeyboardAwareScrollView mode="layout" contentContainerStyle={styles.modalPosition} bottomOffset={16}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.modalSheet}>
          {header}
          <View pointerEvents={saving ? 'none' : 'auto'} style={[styles.formContent, deletingItem && styles.hidden]}>
            {mode === 'copy' && <CopyDueDatesForm candidates={candidates} saving={saving} destination={month} repeatAllowed={repeatAllowed}
              onClose={onClose} onCopy={onCopy} onDelete={onDelete}/>}
            {mode === 'save' && <DueDateForm month={month} item={item} categoriesEnabled={categoriesEnabled}
              onClose={onClose} onSave={onSave} onStopRecurrence={onStopRecurrence}/>}
            {mode === 'pay' && item && <DueDatePaymentForm item={item} sharedAllowed={sharedAllowed}
              hasExpense={hasExpense} onClose={onClose} onPay={onPay}/>}
          </View>
          {!!deletingItem && <View style={styles.formContent}>
            <Text style={styles.expenseLabel}>{deletingItem.title}</Text>
            <Text style={styles.homeExpensePayer}>{longDate.format(parseDate(deletingItem.date))}</Text>
            <View style={styles.formButtons}>
              <MotionButton accessibilityRole="button" disabled={saving} onPress={onCancelDelete} style={styles.cancelButton}>
                <Text style={styles.cancelText}>Cancelar</Text>
              </MotionButton>
              <MotionButton accessibilityRole="button" disabled={saving} onPress={onConfirmDelete}
                style={[styles.saveButton, styles.dueDeleteConfirm]}>
                <Text style={styles.saveText}>Eliminar</Text>
              </MotionButton>
            </View>
          </View>}
        </View>
      </KeyboardAwareScrollView>}
    </SafeAreaView>
  </SafeAreaModal>;
}

const excludedDueDateCategories = new Set<Category>(['panaderia', 'carniceria', 'salidas', 'comida', 'cine', 'teatro', 'supermercado', 'verduleria']);

function DueDateForm({ month, item, categoriesEnabled, onClose, onSave, onStopRecurrence, createLayout }: {
  month: string; item?: DueDate; onClose: () => void; onSave: (draft: DueDateDraft) => void;
  categoriesEnabled: boolean;
  onStopRecurrence?: (item: DueDate) => void;
  createLayout?: { header: ReactNode; saving: boolean };
}) {
  const { bottom } = useSafeAreaInsets();
  const [footerHeight, setFooterHeight] = useState(0);
  const [title, setTitle] = useState(item?.title ?? '');
  const [date, setDate] = useState(() => item?.date ?? moveDueDateToMonth(dateInput(), month));
  const [payableFrom, setPayableFrom] = useState<string | null>(() => item ? payableFromDate(item.date, item.paymentWindowDays) : null);
  const [remindDaily, setRemindDaily] = useState(item?.remindDaily ?? false);
  const [amount, setAmount] = useState<AmountEntry>(() => editAmount(item?.amount ?? undefined));
  const [currency, setCurrency] = useState<Currency>(item?.currency ?? 'ARS');
  const [category, setCategory] = useState(item?.category);
  const [categoryGroup, setCategoryGroup] = useState<CategoryGroup | null>(null);
  const categoryLabel = CATEGORIES.find(option => option.id === category)?.label;

  function submit() {
    const name = title.trim() || categoryLabel;
    if (!name) return Alert.alert('Falta el nombre', 'Escribí qué cuenta tenés que pagar.');
    const parsed = amount === '' ? null : parseMoneyInput(amount);
    if (amount !== '' && (parsed === null || parsed > 999999999999)) {
      return Alert.alert('Revisá el monto', 'Ingresá un importe entero mayor a cero o dejá el campo vacío.');
    }
    if (payableFrom && payableFrom > date) {
      return Alert.alert('Revisá las fechas', 'La fecha desde la que podés pagar debe ser igual o anterior al vencimiento.');
    }
    onSave({
      title: name, date, amount: parsed, currency, category,
      paymentWindowDays: payableFrom ? paymentWindowDays(payableFrom, date) : undefined,
      remindDaily: !!payableFrom && payableFrom < date && remindDaily,
    });
  }

  const fields = <>
    <DateField value={payableFrom} defaultDate={date} label="Se puede pagar desde · opcional"
      onChange={setPayableFrom} onClear={() => { setPayableFrom(null); setRemindDaily(false); }}/>
    <DateField value={date} onChange={setDate} label="Vence el"/>
    {payableFrom && payableFrom < date && <MotionButton accessibilityRole="switch" accessibilityState={{ checked: remindDaily }}
      onPress={() => setRemindDaily(value => !value)} style={[styles.sharedButton, remindDaily && styles.toggleActive]}>
      <Text style={[styles.expenseLabel, remindDaily && styles.toggleTextActive]}>Avisarme todos los días</Text>
    </MotionButton>}
    <FormField label="Monto · opcional">
      <CurrencyPicker currency={currency} onChange={setCurrency}/>
      <AmountField currency={currency} value={amount} onChange={setAmount} autoFocus={false}/>
    </FormField>
    {categoriesEnabled && <CategoryPicker category={category} groupId={categoryGroup} exclude={excludedDueDateCategories}
      onGroupChange={setCategoryGroup} onSelect={setCategory}/>}
    <FormField label={categoryLabel ? 'Nombre · opcional' : 'Nombre'}>
      <TextField value={title} onChange={setTitle} placeholder={categoryLabel ?? 'Ej. Tarjeta BBVA'}/>
    </FormField>
    {item?.repeatsMonthly && onStopRecurrence && <MotionButton accessibilityRole="button"
      onPress={() => onStopRecurrence(item)} style={styles.dueCopyButton}>
      <Text style={styles.homeBalanceLinkText}>Dejar de repetir</Text>
    </MotionButton>}
  </>;

  if (createLayout) {
    return <>
      <KeyboardAwareScrollView mode="layout" style={styles.content} contentContainerStyle={styles.modalPosition}
        bottomOffset={footerHeight + bottom + 12} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={[styles.modalSheet, styles.dueCreateSheet]}>
          {createLayout.header}
          <View pointerEvents={createLayout.saving ? 'none' : 'auto'} style={styles.formContent}>
            {fields}
          </View>
        </View>
      </KeyboardAwareScrollView>
      <KeyboardStickyView style={styles.expenseFooter} onLayout={event => setFooterHeight(event.nativeEvent.layout.height)}>
        <MotionButton accessibilityRole="button" disabled={createLayout.saving} onPress={submit} style={styles.expenseSave}>
          <Text style={styles.expenseSaveText}>{createLayout.saving ? 'Guardando…' : 'Crear vencimiento'}</Text>
        </MotionButton>
      </KeyboardStickyView>
    </>;
  }

  return <>
    {fields}
    <FormButtons onCancel={onClose} onSubmit={submit} title="Guardar cambios"/>
  </>;
}

const duePaymentOptions = [
  ['check', 'Solo marcar'],
  ['personal', 'Gasto personal'],
  ['shared', 'Gasto compartido'],
  ['split', 'Dividir el pago'],
] as const;
type DuePaymentOption = typeof duePaymentOptions[number][0];

function DueDatePaymentForm({ item, sharedAllowed, hasExpense, onClose, onPay }: {
  item: DueDate; sharedAllowed: boolean; hasExpense: boolean;
  onClose: () => void; onPay: (payment: DueDatePayment) => void;
}) {
  const [option, setOption] = useState<DuePaymentOption>('check');
  const [date, setDate] = useState(() => dateInput());
  const [amount, setAmount] = useState<AmountEntry>(() => editAmount(item.amount ?? undefined));
  const [portion, setPortion] = useState<AmountEntry>('');
  const selection = hasExpense ? 'check' : option;
  const total = parseMoneyInput(amount);
  const share = parseMoneyInput(portion);

  function submit() {
    if (selection === 'check') {
      onPay({ date });
      return;
    }
    if (total === null || total > 999999999999) {
      return Alert.alert('Revisá el monto', 'Ingresá el total que pagaste.');
    }
    if (selection === 'split' && (share === null || share >= total)) {
      return Alert.alert('Revisá la parte compartida', 'Ingresá un importe mayor a cero y menor al total pagado.');
    }
    const sharedAmount = selection === 'shared' ? total : selection === 'split' ? share! : 0;
    onPay({ date, expense: { total, sharedAmount } });
  }

  return <>
    <View style={styles.duePaymentHeading}>
      <CategoryMark category={item.category ?? 'otros'}/>
      <Text style={styles.expenseLabel}>{item.title}</Text>
    </View>
    {hasExpense ? <Text style={styles.movementSub}>Este pago ya tiene un registro en Gastos.</Text> :
      <View style={styles.duePaymentOptions}>
        {duePaymentOptions.slice(0, sharedAllowed ? undefined : 2).map(([id, label]) =>
          <Pill key={id} active={selection === id} onPress={() => setOption(id)}>{label}</Pill>)}
      </View>}
    <DateField value={date} onChange={setDate} label="Fecha de pago"/>
    {selection !== 'check' && <FormField label="Total pagado">
      <AmountField value={amount} onChange={setAmount} currency={item.currency} autoFocus={false}/>
    </FormField>}
    {selection === 'split' && <FormField label="Parte compartida">
      <AmountField value={portion} onChange={setPortion} currency={item.currency} autoFocus={false}/>
      {total !== null && share !== null && share < total &&
        <Text style={styles.fieldLabel}>{`Parte personal · ${money(total - share, item.currency)}`}</Text>}
    </FormField>}
    <FormButtons onCancel={onClose} onSubmit={submit} title={selection === 'check' ? 'Marcar como pagado' : 'Registrar pago'}/>
  </>;
}

function CopyDueDatesForm({ candidates, saving, destination, repeatAllowed, onClose, onCopy, onDelete }: {
  candidates: DueDate[]; saving: boolean; destination: string; repeatAllowed: boolean;
  onClose: () => void; onCopy: (ids: string[], repeatMonthly: boolean) => void;
  onDelete: (item: DueDate) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [openDeleteId, setOpenDeleteId] = useState<string | null>(null);
  const [repeatMonthly, setRepeatMonthly] = useState(false);
  function submit() {
    const ids = candidates.filter(item => selected.includes(item.id)).map(item => item.id);
    if (!ids.length) return Alert.alert('Elegí qué cuentas copiar', 'Marcá al menos un vencimiento.');
    onCopy(ids, repeatAllowed && repeatMonthly);
  }
  if (!candidates.length) return <EmptyState title="Sin vencimientos para copiar" body="Elegí otro mes para buscar más vencimientos."/>;
  return <>
    <Text style={styles.dueCopyDestination}>{`Destino · ${formatMonth(destination)}`}</Text>
    <View style={styles.listCard}>
      {candidates.map(item => <DueDateSwipeRow key={item.id} item={item} open={openDeleteId === item.id}
        disabled={saving} onOpenChange={setOpenDeleteId} onDelete={onDelete}>
        <View style={[styles.movementRow, styles.dueRow]}>
          <DueDateCheck checked={selected.includes(item.id)} disabled={saving} label={`Copiar ${item.title}`}
            onPress={() => setSelected(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}/>
          <View style={styles.movementInfo}>
            <Text style={styles.movementTitle}>{item.title}</Text>
            <Text style={styles.homeExpensePayer}>{formatDate(moveDueDateToMonth(item.date, destination, item.scheduledDay))}</Text>
          </View>
          {item.amount !== null && <Text style={styles.movementAmount}>{money(item.amount, item.currency)}</Text>}
        </View>
      </DueDateSwipeRow>)}
    </View>
    {repeatAllowed && <MotionButton accessibilityRole="switch" accessibilityState={{ checked: repeatMonthly }}
      disabled={saving} onPress={() => setRepeatMonthly(value => !value)}
      style={[styles.sharedButton, repeatMonthly && styles.toggleActive]}>
      <Text style={[styles.expenseLabel, repeatMonthly && styles.toggleTextActive]}>Repetir todos los meses</Text>
    </MotionButton>}
    <FormButtons onCancel={onClose} onSubmit={submit}
      title={repeatAllowed && repeatMonthly ? 'Activar repetición' : 'Copiar seleccionados'}/>
  </>;
}

function AnalysisScreen({ month, setMonth, mode, setMode, expenses, active, cash, onIncome, onMovementPress, cashInterestRate, cashInterestBalance, onCashInterestChange }: {
  month: string; setMonth: (x: string) => void; mode: AnalysisMode; setMode: (x: AnalysisMode) => void;
  expenses: Expense[]; active: PersonId;
  cashInterestRate: number; cashInterestBalance: number; onCashInterestChange: (annualPercent: number) => Promise<void>;
  cash: ReturnType<typeof getMonthlyCash>; onIncome: () => void; onMovementPress: OpenMovement;
}) {
  const metrics = useMemo(() => currencyPages.map(option => getMetrics(expenses, active, month, mode, option)),
    [expenses, active, month, mode]);
  const modes: readonly [AnalysisMode, string][] = [['own', 'Mis pagos'], ['shared', 'Compartidos']];

  return <>
    <MonthSelector month={month} onChange={setMonth}/>
    <MonthlyCashCard heading={cashHeading(month, dateInput().slice(0, 7))} cash={cash}
      interestRate={cashInterestRate} interestBalance={cashInterestBalance}
      onInterestChange={month === interestBusinessDay().slice(0, 7) ? onCashInterestChange : undefined} onIncome={onIncome} onMovementPress={onMovementPress}/>
    <View style={[styles.selectorRow, styles.analysisSelectors]}>
      <View style={styles.pillGroup}>
        {modes.map(([id, label]) => <Pill key={id} active={mode === id} onPress={() => setMode(id)}>{label}</Pill>)}
      </View>
    </View>
    <View style={styles.analysisCard}>
      <SwipePages page={modes.findIndex(([option]) => option === mode)} onPageChange={index => setMode(modes[index][0])}
        pages={modes.map(([option]) => ({
          key: option,
          content: <View style={styles.analysisTotals}>
            {currencyPages.map((currency, index) => <AnalysisCurrencyTotal key={currency}
              month={month} mode={option} currency={currency} metrics={metrics[index]}/>)}
          </View>,
        }))}/>
    </View>
    <CategoryBreakdown pesos={metrics[0].categories} dollars={metrics[1].categories}/>
  </>;
}

function AnalysisCurrencyTotal({ month, mode, currency, metrics }: {
  month: string; mode: AnalysisMode; currency: Currency; metrics: ReturnType<typeof getMetrics>;
}) {
  const value = metrics[mode];
  const previous = mode === 'own' ? metrics.previousOwn : metrics.previousShared;
  const comparisonMonth = monthName(previousMonth(month));
  const previousLabel = comparisonMonth[0].toUpperCase() + comparisonMonth.slice(1);
  const change = previous ? Math.round(((value - previous) / previous) * 100) : 0;
  return <View style={currency === 'USD' && styles.analysisDollarTotal}>
    <Text style={styles.currencyBalanceLabel}>{currency === 'ARS' ? 'Pesos' : 'Dólares'}</Text>
    <Text style={[styles.analysisAmount, currency === 'USD' && styles.analysisDollarAmount]}>{money(value, currency)}</Text>
    <Text style={[styles.changeText, change > 0 && styles.changeUp]}>
      {previous > 0
        ? `${change > 0 ? '↑ ' : change < 0 ? '↓ ' : ''}${Math.abs(change)}% vs. ${comparisonMonth}`
        : `${previousLabel} · ${money(previous, currency)}`}
    </Text>
  </View>;
}

function CategoryBreakdown({ pesos, dollars }: {
  pesos: ReturnType<typeof getMetrics>['categories'];
  dollars: ReturnType<typeof getMetrics>['categories'];
}) {
  const categories = new Map([...pesos, ...dollars].map(category => [category.id, category]));
  const series = [
    { currency: 'ARS', amounts: new Map(pesos.map(category => [category.id, category.amount])), max: pesos[0]?.amount ?? 1 },
    { currency: 'USD', amounts: new Map(dollars.map(category => [category.id, category.amount])), max: dollars[0]?.amount ?? 1 },
  ] as const;

  return <>
    <SectionHeader overline="EN QUÉ SE FUE" title="Por categoría"/>
    <View style={styles.chartCard}>
      {categories.size ? [...categories.values()].map(category => <View key={category.id} style={styles.chartRow}>
        <CategoryMark category={category.id} small/>
        <View style={styles.chartBody}>
          <Text style={styles.chartLabel}>{category.label}</Text>
          {series.map(({ currency, amounts, max }) => {
            const amount = amounts.get(category.id);
            if (!amount) return null;
            return <View key={currency} style={styles.chartAmountRow}>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.max(5, amount / max * 100)}%`, backgroundColor: category.color }]}/>
              </View>
              <Text style={styles.chartValue}>{money(amount, currency)}</Text>
            </View>;
          })}
        </View>
      </View>) : <EmptyState title="Sin datos para este mes" body="Probá elegir otro período."/>}
    </View>
  </>;
}

function MonthlyCashCard({ heading, cash, onIncome, onMovementPress, interestRate, interestBalance, onInterestChange }: {
  interestRate: number; interestBalance: number; onInterestChange?: (annualPercent: number) => Promise<void>;
  heading: string; cash: ReturnType<typeof getMonthlyCash>; onIncome: () => void; onMovementPress: OpenMovement;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = [
    { label: 'Ingresos', amount: cash.incomeTotal - cash.interestTotal, sign: '+' },
    { label: 'Reintegros recibidos', amount: cash.received, sign: '+' },
    { label: 'Gastos que pagaste', amount: cash.expensesPaid, sign: '−' },
    { label: 'Pagos de deuda', amount: cash.sent, sign: '−' },
  ];
  if (cash.interestTotal) rows.push({ label: 'Rendimientos del disponible', amount: cash.interestTotal, sign: '+' });
  if (cash.savingsDeposits) rows.push({ label: 'Aportes al ahorro', amount: cash.savingsDeposits, sign: '−' });
  if (cash.savingsWithdrawals) rows.push({ label: 'Retiros del ahorro', amount: cash.savingsWithdrawals, sign: '+' });
  return <View style={styles.monthlyCash}>
    <View style={styles.cashInterestHeading}>
      <Text accessibilityRole="header" style={[styles.expenseLabel, { flexShrink: 1 }]}>{heading}</Text>
      {onInterestChange && <PersonalInterestControl cash rate={interestRate} balance={interestBalance} onSave={onInterestChange}/>}
    </View>
    <Text style={[styles.monthlyAmount, cash.remaining < 0 && styles.homeAmountOwed]}>
      {cash.remaining < 0 ? '−' : ''}{money(cash.remaining)}
    </Text>
    {onInterestChange && interestRate > 0 && <Text style={styles.movementSub}>
      + {money(dailyPersonalInterest(interestBalance, interestRate))} estimados por día
    </Text>}
    <View style={styles.cardActions}>
      <MotionButton accessibilityRole="button" onPress={onIncome} style={styles.smallPrimaryButton}>
        <Text style={styles.smallPrimaryButtonText}>＋ Registrar ingreso</Text>
      </MotionButton>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.homeBalanceLink}>
        <Text style={styles.homeBalanceLinkText}>{expanded ? 'Ocultar detalle' : 'Ver detalle'}</Text>
      </Pressable>
    </View>
    {expanded && <View style={styles.monthlyDetail}>
      {rows.map(({ label, amount, sign }) => <View key={label} style={styles.monthlyRow}>
        <Text style={styles.monthlySub}>{label}</Text>
        <Text style={styles.monthlyValue}>{amount ? sign + ' ' : ''}{money(amount)}</Text>
      </View>)}
      <Text accessibilityRole="header" style={styles.incomeHeading}>Ingresos registrados</Text>
      {cash.incomes.length ? cash.incomes.map(entry => (
        <View key={entry.id} style={styles.incomeRow}>
          <Pressable accessibilityRole="button" accessibilityHint="Abre el detalle del ingreso"
            onPress={() => onMovementPress({ kind: 'income', entry })}
            style={({ pressed }) => [styles.monthlyRow, styles.incomeRowDetail, pressed && styles.editableRowPressed]}>
            <View style={styles.movementInfo}>
              <Text style={styles.monthlySub}>{entry.note || 'Ingreso'}</Text>
              <Text style={styles.homeExpensePayer}>{formatDate(entry.date)}</Text>
            </View>
            <Text style={styles.monthlyValue}>{money(entry.amount)}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Editar ${entry.note || 'ingreso'}`}
            onPress={() => onMovementPress({ kind: 'income', entry }, true)}
            style={({ pressed }) => [styles.incomeEditButton, pressed && styles.incomeEditButtonPressed]}>
            <Text style={styles.expenseSaveText}>Editar</Text>
          </Pressable>
        </View>
      )) : <Text style={styles.monthlySub}>Todavía no registraste ingresos.</Text>}
    </View>}
  </View>;
}

function EmptyState({ title, body }: { title: string; body: string }) { return <View style={styles.empty}><Text style={styles.emptySpark}>✳</Text><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyBody}>{body}</Text></View>; }

function MovementModal({ form, net, usdNet, transferCurrency, partner, account, active, data, month, saving, movement, editing, onClose, onEdit, onDelete, onTransfer, onDebt, onSaving, onIncome }: {
  form: FormName; net: number; partner: string; account: SavingMove['account']; active: PersonId; data: DuoData; month: string;
  usdNet: number;
  transferCurrency: Currency;
  saving: boolean;
  movement?: OtherMovement;
  editing: boolean;
  onClose: () => void;
  onEdit: OpenMovement;
  onDelete: OpenMovement;
  onTransfer: (entry: NewTransfer) => void;
  onDebt: (entry: NewDebt) => void;
  onSaving: (entry: NewSaving) => void;
  onIncome: (entry: NewIncome) => void;
}) {
  const titles = { transfer: 'Liquidar deuda', saving: 'Movimiento de ahorro', income: 'Registrar ingreso', debt: 'Registrar deuda' };
  const editTitles = { transfer: 'Editar pago', saving: 'Editar ahorro', income: 'Editar ingreso', debt: 'Editar deuda' };
  const detailTitles = { transfer: 'Detalle del pago', saving: 'Detalle del ahorro', income: 'Detalle del ingreso', debt: 'Detalle de la deuda' };
  const draft = editing ? movement : undefined;
  const activeForm = draft?.kind ?? form;
  const title = movement ? (draft ? editTitles : detailTitles)[movement.kind] : form ? titles[form] : '';
  const originalSaving = draft?.kind === 'saving' ? draft.entry : undefined;
  const originalTransfer = draft?.kind === 'transfer' ? draft.entry : undefined;
  const paymentCurrency = originalTransfer ? originalTransfer.currency ?? 'ARS' : transferCurrency;
  return <SafeAreaModal visible={form !== null || !!movement} transparent animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={styles.modalBackdrop}>
      <KeyboardAwareScrollView mode="layout" contentContainerStyle={styles.modalPosition}
        bottomOffset={16}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.modalSheet}><View style={styles.modalHandle}/><View style={styles.modalHeading}>
          <Text accessibilityRole="header" style={styles.modalTitle}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Cerrar" onPress={onClose} disabled={saving} style={styles.modalClose}><Text>×</Text></Pressable>
        </View>
          {saving && <Text accessibilityLiveRegion="polite" style={styles.syncBanner}>Guardando…</Text>}
          <View style={styles.formContent} pointerEvents={saving ? 'none' : 'auto'}>
            {movement && !draft && <MovementDetails movement={movement} active={active} onEdit={onEdit} onDelete={onDelete}/>}
            {activeForm === 'transfer' && <TransferForm original={originalTransfer} currency={paymentCurrency}
              net={paymentCurrency === 'USD' ? usdNet : net} partner={partner} onSave={onTransfer} onCancel={onClose}/>}
            {activeForm === 'debt' && <DebtForm original={draft?.kind === 'debt' ? draft.entry : undefined}
              active={active} partner={partner} onSave={onDebt} onCancel={onClose}/>}
            {activeForm === 'saving' && <SavingForm original={originalSaving} account={originalSaving?.account ?? account}
              active={active} data={data} onSave={onSaving} onCancel={onClose}/>}
            {activeForm === 'income' && <IncomeForm original={draft?.kind === 'income' ? draft.entry : undefined}
              month={month} onSave={onIncome} onCancel={onClose}/>}
          </View>
        </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  </SafeAreaModal>;
}

function MovementDetails({ movement, active, onEdit, onDelete }: {
  movement: OtherMovement; active: PersonId; onEdit: OpenMovement; onDelete: OpenMovement;
}) {
  const people = useContext(PeopleContext);
  const { entry } = movement;
  const owner = movementOwner(movement);
  const context = movement.kind === 'income' ? 'Ingreso personal'
    : movement.kind === 'transfer' ? `${people[movement.entry.from]} → ${people[movement.entry.to]}`
    : movement.kind === 'debt' ? `${people[movement.entry.from]} le debe a ${people[movement.entry.to]}`
      : `${movement.entry.kind === 'deposit' ? 'Aporte' : 'Retiro'} · ${movement.entry.account === 'shared' ? 'Ahorro compartido' : 'Ahorro personal'}`;
  const currency = movement.kind === 'debt' ? 'USD' : movement.kind === 'income' ? 'ARS' : movement.entry.currency;
  return <>
    <View style={styles.detailHero}>
      <Text style={styles.detailCaption}>{context}</Text>
      <Text style={styles.detailAmount}>{money(entry.amount, currency)}</Text>
      <Text style={styles.detailCaption}>{longDate.format(parseDate(entry.date))}</Text>
      {!!entry.note && <Text style={styles.detailDescription}>{entry.note}</Text>}
      {movement.kind === 'saving' && movement.entry.excludeFromMonthlyCash && <Text style={styles.detailCaption}>Sin descontar del mes</Text>}
    </View>
    {owner === active && <View style={styles.detailActions}>
      <Pressable accessibilityRole="button" onPress={() => onDelete(movement)} style={styles.detailDelete}>
        <Text style={styles.detailDeleteText}>Eliminar</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => onEdit(movement)} style={[styles.expenseSave, styles.detailEdit]}>
        <Text style={styles.expenseSaveText}>Editar</Text>
      </Pressable>
    </View>}
  </>;
}

function editAmount(amount?: number): AmountEntry {
  if (amount === undefined) return '';
  return Number.isInteger(amount) ? formatMoneyInput(String(amount)) ?? '' : amount;
}

function DateField({ value, onChange, spacious = false, label = 'Fecha', defaultDate, onClear }: {
  value: string | null; onChange: (x: string) => void; spacious?: boolean; label?: string;
  defaultDate?: string; onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <View style={styles.field}>
    <Text style={spacious ? styles.expenseLabel : styles.fieldLabel}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value ?? 'Elegir fecha'}`} onPress={() => setOpen(true)} style={[styles.dateButton, spacious && styles.expenseControl]}>
      <Text style={[styles.dateValue, spacious && styles.expenseLabel]}>{value ? formatDate(value) : 'Elegir fecha'}</Text>
      {value && <Text style={styles.dateFull}>{value}</Text>}
      <Text style={styles.dateCalendar}>▦</Text>
    </Pressable>
    {value && onClear && <Pressable accessibilityRole="button" accessibilityLabel="Quitar fecha de inicio"
      onPress={onClear} style={styles.dateDone}><Text style={styles.dateDoneText}>Quitar fecha</Text></Pressable>}
    {open && <DateTimePicker value={parseDate(value ?? defaultDate ?? dateInput())} mode="date" display={Platform.OS === 'ios' ? 'spinner' : 'default'}
      onChange={(event, selected) => {
        if (event.type === 'set' && selected) onChange(dateInput(selected));
        if (Platform.OS === 'android') setOpen(false);
      }}/>}
    {open && Platform.OS === 'ios' && <Pressable onPress={() => setOpen(false)} style={styles.dateDone}><Text style={styles.dateDoneText}>Listo</Text></Pressable>}
  </View>;
}

function CurrencyPicker({ currency, onChange }: {
  currency: Currency; onChange: (currency: Currency) => void;
}) {
  const options = [
    { currency: 'ARS', label: 'Pesos argentinos' },
    { currency: 'USD', label: 'Dólares estadounidenses' },
  ] as const;
  return <View style={styles.savingKindRow}>
    {options.map(option => <Pill key={option.currency} active={currency === option.currency}
      accessibilityLabel={option.label} onPress={() => onChange(option.currency)}>
      {option.currency}
    </Pill>)}
  </View>;
}

function FormField({ label, children }: { label: string; children: ReactNode }) { return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>; }
function AmountField({ currency = 'ARS', value, onChange, autoFocus = true, fullBalance = 0 }: {
  currency?: Currency; value: AmountEntry; onChange: (entry: AmountEntry) => void; autoFocus?: boolean; fullBalance?: number;
}) {
  const exact = exactBalanceOption(fullBalance);
  const selected = typeof value === 'number';

  function changeAmount(text: string) {
    const formatted = formatMoneyInput(text);
    if (formatted !== null) onChange(formatted);
  }

  return <>
    <View style={styles.amountInput}>
      <Text style={styles.currencyPrefix}>{currency === 'USD' ? 'US$' : '$'}</Text>
      {selected ? <Text style={styles.amountTextInput}>{amountFormat.format(value)}</Text> :
        <TextInput accessibilityLabel="Monto" value={value} onChangeText={changeAmount} keyboardType="number-pad"
          placeholder="0" placeholderTextColor="#a9b1aa" style={styles.amountTextInput} autoFocus={autoFocus}/>}
      <Text style={styles.currencyCode}>{currency}</Text>
    </View>
    {(selected || exact !== null) && <Pressable accessibilityRole="button" onPress={() => onChange(selected ? '' : exact ?? '')} style={styles.homeBalanceLink}>
      <Text style={styles.homeBalanceLinkText}>{selected ? 'Escribir otro monto' : 'Usar saldo completo'}</Text>
    </Pressable>}
  </>;
}
function TextField({ value, onChange, placeholder }: { value: string; onChange: (x: string) => void; placeholder: string }) {
  return <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor="#a9b1aa" style={styles.textInput} maxLength={80}/>;
}
function FormButtons({ onCancel, onSubmit, title }: { onCancel: () => void; onSubmit: () => void; title: string }) {
  return <View style={styles.formButtons}>
    <MotionButton accessibilityRole="button" onPress={onCancel} style={styles.cancelButton}>
      <Text style={styles.cancelText}>Cancelar</Text>
    </MotionButton>
    <MotionButton accessibilityRole="button" onPress={onSubmit} style={styles.saveButton}>
      <Text style={styles.saveText}>{title}</Text>
    </MotionButton>
  </View>;
}

function IncomeForm({ month, original, onSave, onCancel }: { month: string; original?: Income; onSave: (entry: NewIncome) => void; onCancel: () => void }) {
  const [amount, setAmount] = useState<AmountEntry>(() => editAmount(original?.amount));
  const [date, setDate] = useState(() => {
    if (original) return original.date;
    const today = dateInput();
    return today.startsWith(month) ? today : `${month}-01`;
  });
  const [note, setNote] = useState(original?.note ?? '');

  function submit() {
    const parsed = parseMoneyInput(amount);
    if (parsed === null) {
      Alert.alert('Revisá el monto', 'Ingresá un importe mayor a cero.');
      return;
    }
    onSave({ amount: parsed, date, note: note.trim() });
  }

  return <>
    <FormField label="Monto recibido"><AmountField value={amount} onChange={setAmount}/></FormField>
    <DateField value={date} onChange={setDate} spacious/>
    <FormField label="Detalle · opcional"><TextField value={note} onChange={setNote} placeholder="Ej. Sueldo"/></FormField>
    <FormButtons onCancel={onCancel} onSubmit={submit} title={original ? 'Guardar cambios' : 'Guardar ingreso'}/>
  </>;
}

function ExpenseDetails({ expense, active, saving: savingExpense, onClose, onEdit, onDelete, receiptsEnabled, onReceiptBusy }: {
  expense: Expense;
  active: PersonId;
  saving: boolean;
  receiptsEnabled: boolean;
  onReceiptBusy: (busy: boolean) => void;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [receiptBusy, setReceiptBusy] = useState(false);
  const saving = savingExpense || receiptBusy;
  const people = useContext(PeopleContext);
  const category = CATEGORIES.find(item => item.id === expense.category);
  const own = expense.paidBy === active;
  const partner = active === 'adri' ? 'mel' : 'adri';
  const portion = money(expense.amount / 2, expense.currency);

  return <SafeAreaView style={styles.expenseScreen}>
    <View style={styles.expenseHeader}>
      <Text accessibilityRole="header" style={styles.expenseTitle}>Detalle del gasto</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Cerrar detalle del gasto" onPress={onClose} disabled={saving} style={styles.expenseClose}>
        <Text style={styles.expenseCloseText}>×</Text>
      </Pressable>
    </View>
    <ScrollView style={styles.content} contentContainerStyle={styles.expenseFields}>
      <View style={styles.detailHero}>
        <View style={styles.detailCategory}>
          <CategoryMark category={expense.category}/>
          <Text style={styles.detailCaption}>{category?.label ?? 'Gasto'} · {expense.shared ? 'Compartido' : 'Personal'}</Text>
        </View>
        {!!expense.description && <Text style={styles.detailDescription}>{expense.description}</Text>}
        <Text style={styles.detailAmount}>{money(expense.amount, expense.currency)}</Text>
        <Text style={styles.detailCaption}>{longDate.format(parseDate(expense.date))}</Text>
      </View>
      <View style={styles.detailLedger}>
        <Text style={styles.expenseLabel}>{own ? 'Pagaste vos' : `Pagó ${people[expense.paidBy]}`}</Text>
        {expense.shared && <View style={styles.monthlyDetail}>
          <Text style={styles.detailCaption}>Cómo se dividió</Text>
          <View style={styles.monthlyRow}><Text style={styles.monthlySub}>Tu parte</Text><Text style={styles.monthlyValue}>{portion}</Text></View>
          <View style={styles.monthlyRow}><Text style={styles.monthlySub}>Parte de {people[partner]}</Text><Text style={styles.monthlyValue}>{portion}</Text></View>
        </View>}
      </View>
      <ExpenseReceiptSection client={receiptsEnabled ? cloudClient : null} expenseId={receiptsEnabled ? expense.id : undefined}
        editable={own && receiptsEnabled} disabled={savingExpense} onBusy={busy => { setReceiptBusy(busy); onReceiptBusy(busy); }}/>
    </ScrollView>
    {own && <View style={[styles.expenseFooter, styles.detailActions]}>
      <Pressable accessibilityRole="button" disabled={saving} onPress={onDelete} style={styles.detailDelete}>
        <Text style={styles.detailDeleteText}>{saving ? 'Eliminando…' : 'Eliminar'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={saving} onPress={onEdit} style={[styles.expenseSave, styles.detailEdit]}>
        <Text style={styles.expenseSaveText}>Editar gasto</Text>
      </Pressable>
    </View>}
  </SafeAreaView>;
}

function ExpenseForm({ expense, onSave, onClose, sharedAllowed, initiallyShared, saving: savingExpense, receiptsEnabled, onReceiptBusy }: {
  expense?: Expense;
  onSave: (entry: ExpenseDraft, file?: ReceiptFile | null) => void;
  onClose: () => void;
  sharedAllowed: boolean;
  initiallyShared: boolean;
  saving: boolean;
  receiptsEnabled: boolean;
  onReceiptBusy: (busy: boolean) => void;
}) {
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptDraft, setReceiptDraft] = useState<ReceiptFile | null>(null);
  const receiptRef = useRef<ReceiptFile | null>(null);
  const saving = savingExpense || receiptBusy;
  useEffect(() => () => { if (receiptRef.current) releaseReceipt(receiptRef.current); }, []);
  function changeReceipt(file: ReceiptFile | null) {
    if (receiptRef.current) releaseReceipt(receiptRef.current);
    receiptRef.current = file;
    setReceiptDraft(file);
  }
  const [amount, setAmount] = useState<AmountEntry>(() => expense ? formatMoneyInput(String(expense.amount)) ?? '' : '');
  const [currency, setCurrency] = useState<Currency>(expense?.currency ?? 'ARS');
  const [category, setCategory] = useState<Category>(expense?.category ?? 'supermercado');
  const [categoryGroup, setCategoryGroup] = useState<CategoryGroup | null>(null);
  const [description, setDescription] = useState(expense?.description ?? '');
  const [footerHeight, setFooterHeight] = useState(0);
  const [date, setDate] = useState(() => expense?.date ?? dateInput());
  const [shared, setShared] = useState(expense?.shared ?? initiallyShared);
  const group = CATEGORY_GROUPS.find(item => item.id === categoryGroup);

  const submit = () => {
    const parsed = parseMoneyInput(amount);
    if (parsed === null || parsed > 999999999999) {
      Alert.alert('Revisá el monto', 'Ingresá un importe entero mayor a cero.');
      return;
    }
    if (group && !group.children.some(item => item.id === category)) {
      Alert.alert('Elegí una subcategoría', `Seleccioná un ícono dentro de ${group.label}.`);
      return;
    }
    onSave({ amount: parsed, currency, category, description: description.trim(), date, shared: sharedAllowed ? shared : !!expense?.shared }, receiptDraft);
  };

  return <SafeAreaView style={styles.expenseScreen}>
        <View style={styles.expenseHeader}>
          <Text accessibilityRole="header" style={styles.expenseTitle}>{expense ? 'Editar gasto' : 'Nuevo gasto'}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={expense ? 'Cancelar edición' : 'Cerrar nuevo gasto'} onPress={onClose} disabled={saving} style={styles.expenseClose}>
            <Text style={styles.expenseCloseText}>×</Text>
          </Pressable>
        </View>
        <ExpenseFormFields saving={saving} footerHeight={footerHeight}>
          <View style={styles.field}>
            <Text style={styles.expenseLabel}>¿Cuánto pagaste?</Text>
            <CurrencyPicker currency={currency} onChange={setCurrency}/>
            <AmountField value={amount} onChange={setAmount} currency={currency} autoFocus={false}/>
          </View>
          {sharedAllowed && <MotionButton accessibilityRole="switch" accessibilityState={{ checked: shared }}
            onPress={() => setShared(value => !value)} style={[styles.sharedButton, shared && styles.toggleActive]}>
            <Text style={[styles.expenseLabel, shared && styles.toggleTextActive]}>Agregar a la cuenta compartida</Text>
          </MotionButton>}
          <CategoryPicker category={category} groupId={categoryGroup} onSelect={setCategory} onGroupChange={setCategoryGroup}/>
          <View style={styles.field}>
            <Text style={styles.expenseLabel}>Descripción · opcional</Text>
            <TextInput accessibilityLabel="Descripción" value={description} onChangeText={setDescription}
              placeholder="Ej. Compra de la semana" placeholderTextColor="#6c7a70"
              style={[styles.textInput, styles.expenseTextInput]} maxLength={Math.max(80, expense?.description.length ?? 0)}/>
          </View>
          <DateField value={date} onChange={setDate} spacious/>
          <ExpenseReceiptSection client={receiptsEnabled ? cloudClient : null} expenseId={expense?.id}
            editable={receiptsEnabled} disabled={savingExpense} draft={receiptDraft} onDraft={changeReceipt}
            onBusy={busy => { setReceiptBusy(busy); onReceiptBusy(busy); }}/>
        </ExpenseFormFields>
        <KeyboardStickyView style={styles.expenseFooter} onLayout={event => setFooterHeight(event.nativeEvent.layout.height)}>
          <MotionButton accessibilityRole="button" disabled={saving} accessibilityState={{ disabled: saving }} onPress={submit} style={styles.expenseSave}>
            <Text style={styles.expenseSaveText}>{saving ? 'Guardando…' : expense ? 'Guardar cambios' : 'Guardar gasto'}</Text>
          </MotionButton>
        </KeyboardStickyView>
  </SafeAreaView>;
}

function ExpenseFormFields({ saving, footerHeight, children }: { saving: boolean; footerHeight: number; children: ReactNode }) {
  const { bottom } = useSafeAreaInsets();
  return <KeyboardAwareScrollView bottomOffset={footerHeight + bottom + 12}
    pointerEvents={saving ? 'none' : 'auto'} style={styles.content}
    contentContainerStyle={styles.expenseFields} keyboardShouldPersistTaps="handled">
    {children}
  </KeyboardAwareScrollView>;
}

function TransferForm({ net, currency, partner, original, onSave, onCancel }: {
  net: number; currency: Currency; partner: string; original?: Transfer; onSave: (entry: NewTransfer) => void; onCancel: () => void;
}) {
  const [amount, setAmount] = useState<AmountEntry>(() => editAmount(original?.amount));
  const [date, setDate] = useState(() => original?.date ?? dateInput());
  const [note, setNote] = useState(original?.note ?? '');
  const limit = Math.round(((original?.amount ?? 0) + Math.max(0, -net)) * 100) / 100;
  function submit() {
    const parsed = parseMoneyInput(amount);
    if (parsed === null) return Alert.alert('Revisá el monto', 'Ingresá un importe mayor a cero.');
    if (limit <= 0) return Alert.alert('No tenés una deuda pendiente', 'Solo quien debe puede registrar el pago.');
    if (parsed > limit) return Alert.alert('El monto supera la deuda', `Podés registrar hasta ${money(limit, currency)}.`);
    onSave({ amount: parsed, currency, date, note: note.trim() });
  }
  return <>
    <View style={styles.savingContext}>
      <Text style={styles.savingContextText}>Le pagás a {partner}</Text>
      <Text style={styles.savingContextValue}>{original ? 'Monto máximo' : 'Deuda'} · {money(limit, currency)}</Text>
    </View>
    <FormField label="Monto transferido"><AmountField currency={currency} value={amount} onChange={setAmount} fullBalance={limit}/></FormField>
    <DateField value={date} onChange={setDate}/>
    <FormField label="Detalle · opcional"><TextField value={note} onChange={setNote} placeholder="Ej. Pago parcial"/></FormField>
    <FormButtons onCancel={onCancel} onSubmit={submit} title={original ? 'Guardar cambios' : 'Guardar pago'}/>
  </>;
}

function DebtForm({ active, partner, original, onSave, onCancel }: {
  active: PersonId; partner: string; original?: Debt; onSave: (entry: NewDebt) => void; onCancel: () => void;
}) {
  const [amount, setAmount] = useState<AmountEntry>(() => editAmount(original?.amount));
  const [date, setDate] = useState(() => original?.date ?? dateInput());
  const [note, setNote] = useState(original?.note ?? '');

  function submit() {
    const parsed = parseMoneyInput(amount);
    if (parsed === null || parsed > 999999999999) {
      return Alert.alert('Revisá el monto', 'Ingresá un importe en dólares mayor a cero.');
    }
    if (!note.trim()) return Alert.alert('Falta el motivo', 'Escribí de dónde viene esta deuda.');
    onSave({ amount: parsed, date, note: note.trim() });
  }

  return <>
    <Text style={styles.expenseLabel}>{original?.from === active ? `Le debés a ${partner}` : `${partner} te debe`}</Text>
    <FormField label="Monto de la deuda"><AmountField currency="USD" value={amount} onChange={setAmount}/></FormField>
    <DateField value={date} onChange={setDate}/>
    <FormField label="Motivo"><TextField value={note} onChange={setNote} placeholder="Ej. Compra del auto"/></FormField>
    <FormButtons onCancel={onCancel} onSubmit={submit} title={original ? 'Guardar cambios' : 'Registrar deuda'}/>
  </>;
}

function SavingForm({ account, active, data, original, onSave, onCancel }: {
  account: SavingMove['account']; active: PersonId; data: DuoData; original?: SavingMove;
  onSave: (entry: NewSaving) => void; onCancel: () => void;
}) {
  const people = useContext(PeopleContext);
  const [kind, setKind] = useState<SavingMove['kind']>(original?.kind ?? 'deposit');
  const [currency, setCurrency] = useState<Currency>(original?.currency ?? 'ARS');
  const [amount, setAmount] = useState<AmountEntry>(() => editAmount(original?.amount));
  const [date, setDate] = useState(() => original?.date ?? dateInput());
  const [note, setNote] = useState(original?.note ?? '');
  const [excludeFromMonthlyCash, setExcludeFromMonthlyCash] = useState(original?.excludeFromMonthlyCash ?? false);
  const showCashOption = kind === 'deposit' && currency === 'ARS';
  const balance = getSavingsBalance(data, account, active, currency);
  const available = balance - (original ? original.amount * (original.kind === 'deposit' ? 1 : -1) : 0);
  const submit = () => {
    const parsed = parseMoneyInput(amount);
    if (parsed === null) return Alert.alert('Revisá el monto', 'Ingresá un importe mayor a cero.');
    if (kind === 'withdraw' && parsed > available) return Alert.alert('Saldo insuficiente', `Disponible: ${money(Math.max(0, available), currency)}.`);
    onSave({ amount: parsed, date, currency, kind, note: note.trim(), excludeFromMonthlyCash: showCashOption && excludeFromMonthlyCash });
  };
  const options = [['deposit', 'Aportar'], ['withdraw', 'Retirar']] as const;
  return <>
    {!original?.interestOn && <View style={styles.savingKindRow}>
      {options.map(([value, label]) => {
        const selected = kind === value;
        return <MotionButton key={value} accessibilityRole="radio" accessibilityState={{ checked: selected }}
          onPress={() => { setKind(value); if (value === 'deposit' && typeof amount === 'number') setAmount(''); }}
          style={[styles.sharedButton, styles.savingKindOption, selected && styles.sharedButtonActive]}>
          <Text style={[styles.expenseLabel, selected && styles.sharedButtonTextActive]}>{label}</Text>
        </MotionButton>;
      })}
    </View>}
    {!original && <CurrencyPicker currency={currency} onChange={nextCurrency => {
      if (nextCurrency === currency) return;
      setCurrency(nextCurrency);
      if (typeof amount === 'number') setAmount('');
    }}/>}
    <View style={styles.savingContext}>
      <Text style={styles.savingContextText}>{account === 'personal' ? `Ahorro personal de ${people[active]}` : 'Ahorro compartido'}</Text>
      <Text style={styles.savingContextValue}>Disponible: {money(balance, currency)}</Text>
    </View>
    <FormField label="Monto"><AmountField currency={currency} value={amount} onChange={setAmount}
      autoFocus={!!original} fullBalance={kind === 'withdraw' ? available : 0}/></FormField>
    {showCashOption && !original?.interestOn && <MotionButton accessibilityRole="switch" accessibilityState={{ checked: excludeFromMonthlyCash }}
      onPress={() => setExcludeFromMonthlyCash(value => !value)}
      style={[styles.sharedButton, excludeFromMonthlyCash && styles.toggleActive]}>
      <Text style={[styles.expenseLabel, excludeFromMonthlyCash && styles.toggleTextActive]}>No descontar del mes</Text>
    </MotionButton>}
    {currency === 'USD' && <Text style={styles.savingContextText}>Los movimientos en dólares se registran por separado del disponible en pesos.</Text>}
    <DateField value={date} onChange={setDate}/>
    <FormField label="Detalle · opcional">
      <TextField value={note} onChange={setNote} placeholder={kind === 'deposit' ? 'Ej. Ahorro del sueldo' : 'Ej. Compra del mes'}/>
    </FormField>
    <FormButtons onCancel={onCancel} onSubmit={submit} title={original ? 'Guardar cambios' : kind === 'deposit' ? 'Guardar aporte' : 'Guardar retiro'}/>
  </>;
}

const COLORS = { canvas: '#f5f4ef', paper: '#fffefa', forest: '#21463b', ink: '#26342f', muted: '#85918a', line: '#e8e7e0', lime: '#d4e7a3', soft: '#eaf0e8' };
const CONTENT_GUTTER = 16;
const styles = StyleSheet.create({
  cashInterestHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  interestBalanceHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  expenseFilterRow: { flexWrap: 'nowrap', alignItems: 'center', gap: 2 },
  compactPill: { paddingHorizontal: 9, flexShrink: 1 },
  muted: { color: COLORS.muted, fontSize: 16 },
  withdrawAmount: { color: '#874628' },
  accountButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  accountName: { fontSize: 16, maxWidth: 125 },
  syncBanner: { backgroundColor: COLORS.soft, padding: 12, marginTop: 8, borderRadius: 10 },
  app: { flex: 1, backgroundColor: COLORS.canvas }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.canvas },
  brand: { fontSize: 30, fontWeight: '800', letterSpacing: -2.5, lineHeight: 33, color: COLORS.forest },
  brandDot: { color: '#9ebd6a' },
  demoControls: {
    flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: 24, backgroundColor: COLORS.paper, paddingHorizontal: 5,
  },
  resetButton: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: '#e1e2db', alignItems: 'center', justifyContent: 'center' }, resetText: { fontSize: 19, color: '#77837c', marginTop: -3 }, profileToggle: { flexShrink: 1, flexDirection: 'row', backgroundColor: '#ebeae3', borderRadius: 25, padding: 3 }, profileItem: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 5, padding: 4, paddingRight: 9, borderRadius: 20 }, profileItemActive: { backgroundColor: COLORS.paper, elevation: 1 }, avatar: { width: 24, height: 24, borderRadius: 12, overflow: 'hidden', textAlign: 'center', textAlignVertical: 'center', fontSize: 12, fontWeight: '700', color: '#4a6642', backgroundColor: '#dae8c8' }, avatarMel: { backgroundColor: '#f3dfcf', color: '#9b644e' }, profileName: { flexShrink: 1, color: '#88938c', fontSize: 12 }, profileNameActive: { color: COLORS.ink, fontWeight: '600' },
  content: { flex: 1 },
  contentInner: { paddingBottom: 26 },
  expenseScrollContent: { paddingBottom: 96 },
  swipeViewport: { overflow: 'hidden' },
  swipeContent: { alignItems: 'flex-start' },
  tabContent: { paddingHorizontal: CONTENT_GUTTER, paddingTop: 12 },
  pageHeading: { paddingHorizontal: CONTENT_GUTTER },
  pageHeadingPlain: { minHeight: 72, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  pageTitle: { color: COLORS.ink, fontSize: 30, fontWeight: '700', letterSpacing: -.7 },
  pageHeadingText: { flex: 1, minWidth: 0 },
  pageTitleCover: {
    color: COLORS.paper, textShadowColor: 'rgba(0,0,0,.88)',
    textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  overline: { fontSize: 11, fontWeight: '700', letterSpacing: 1.05, color: '#89958d', marginBottom: 6 },
  monthlyCash: { marginTop: 12, padding: 16, borderRadius: 12, backgroundColor: COLORS.soft, gap: 4 },
  monthlyAmount: { color: COLORS.forest, fontSize: 31, fontWeight: '700', fontVariant: ['tabular-nums'] },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 6 },
  smallPrimaryButton: { minHeight: 44, borderRadius: 8, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: COLORS.forest },
  smallPrimaryButtonText: { color: COLORS.paper, fontWeight: '600', fontSize: 15 },
  monthlyDetail: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#b8c8b8', paddingTop: 10, marginTop: 6, gap: 8 },
  monthlyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  monthlySub: { color: COLORS.ink, fontSize: 15, flexShrink: 1 },
  monthlyValue: { color: COLORS.ink, fontWeight: '600', fontSize: 15, fontVariant: ['tabular-nums'] },
  coverAdd: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  coverFrame: { width: '100%', overflow: 'hidden' },
  coverImage: { width: '100%', aspectRatio: 16 / 9 },
  coverCaption: { position: 'absolute', bottom: 16, left: CONTENT_GUTTER, right: CONTENT_GUTTER },
  coverToolbar: {
    position: 'absolute', top: 8, left: CONTENT_GUTTER, right: CONTENT_GUTTER,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  },
  coverTrigger: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  coverDots: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,.50)' },
  coverDotsText: { color: COLORS.paper, fontSize: 20, lineHeight: 22, includeFontPadding: false },
  coverMenu: { position: 'absolute', top: 52, left: CONTENT_GUTTER, minWidth: 132, paddingHorizontal: 4, borderRadius: 10, backgroundColor: COLORS.paper },
  coverMenuItem: { minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' },
  coverMenuText: { color: COLORS.ink, fontSize: 15, fontWeight: '600' },
  sharedBalanceSection: { marginBottom: 10 },
  homeBalance: { padding: 16, paddingBottom: 10, backgroundColor: COLORS.soft, borderRadius: 12 },
  balanceSummary: { paddingRight: 40 },
  balanceSwitch: { position: 'absolute', top: 5, right: 5, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  balanceSwitchText: { color: COLORS.forest, fontSize: 25, lineHeight: 30 },
  dueActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 14, gap: 12 },
  dueCopyActions: { flexDirection: 'row', marginTop: 10 },
  dueCopyButton: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 10, backgroundColor: COLORS.soft },
  dueCopyDestination: { color: COLORS.ink, fontSize: 14, fontWeight: '600' },
  dueCreateSheet: { paddingBottom: 8 },
  duePaymentHeading: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  duePaymentOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, padding: 4,
    borderRadius: 9, backgroundColor: '#ebeae4' },
  dueSectionTitle: { color: COLORS.ink, fontSize: 18, fontWeight: '700', marginTop: 17, marginBottom: 8 },
  duePaidToggle: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 9 },
  dueRow: { paddingVertical: 0, paddingLeft: 4, gap: 3 },
  dueSwipeRow: { overflow: 'hidden' },
  dueSwipeForeground: { backgroundColor: COLORS.paper },
  dueSwipeDelete: { position: 'absolute', left: 0, top: 0, bottom: 0, width: dueDeleteActionWidth,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#a5362c' },
  dueSwipeDeleteText: { color: COLORS.paper, fontSize: 14, fontWeight: '700' },
  dueDeleteConfirm: { backgroundColor: '#a5362c' },
  hidden: { display: 'none' },
  dueRowDetails: { flex: 1, minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8 },
  dueCheckTarget: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  dueCheck: { width: 21, height: 21, borderRadius: 5, borderWidth: 1, borderColor: '#7d9084', alignItems: 'center', justifyContent: 'center' },
  dueCheckActive: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  dueCheckMark: { color: COLORS.paper, fontSize: 14, fontWeight: '700', includeFontPadding: false },
  homeBalanceStatus: { color: COLORS.ink, fontWeight: '600', fontSize: 17 },
  homeBalanceAmount: { marginTop: 3, color: COLORS.forest, fontWeight: '700', fontSize: 31, fontVariant: ['tabular-nums'] },
  homeAmountOwed: { color: '#874628' },
  homeBalanceLink: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  homeBalanceLinkText: { color: COLORS.forest, fontSize: 15, fontWeight: '600' },
  homeTransferList: { marginTop: 6, marginBottom: 8 },
  historyEmpty: { color: COLORS.ink, paddingBottom: 8, fontSize: 15 },
  homeExpensePayer: { marginTop: 2, color: '#5d6b63', fontSize: 13 },
  expenseActions: { position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'flex-end', paddingHorizontal: CONTENT_GUTTER, paddingBottom: 12, paddingTop: 8 },
  roundedCreateAction: { borderRadius: 24 },
  expenseAdd: { minHeight: 48, paddingHorizontal: 18, justifyContent: 'center', backgroundColor: COLORS.forest },
  expenseAddText: { color: COLORS.paper, fontSize: 17, fontWeight: '600' },
  expensePaidByYou: { color: '#1d6152' },
  expensePaidByPartner: { color: '#994522' },
  tabBarInset: { backgroundColor: COLORS.paper },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(26,40,32,.38)' },
  modalPosition: { flexGrow: 1, justifyContent: 'flex-end' },
  expenseScreen: { flex: 1, backgroundColor: COLORS.paper },
  expenseRowPressed: { backgroundColor: COLORS.soft },
  editableRow: { backgroundColor: '#dcebdc' },
  editableRowPressed: { backgroundColor: '#cfe2ce' },
  editableRowIcon: { color: COLORS.forest, fontSize: 18, lineHeight: 23 },
  incomeHeading: {
    marginTop: 6, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8,
    backgroundColor: COLORS.forest, color: COLORS.paper, fontSize: 16, fontWeight: '700',
  },
  incomeRow: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6,
    padding: 6, borderRadius: 8, backgroundColor: '#cae1cd',
  },
  incomeRowDetail: { flex: 1, minWidth: 140, minHeight: 44, paddingHorizontal: 6, borderRadius: 6 },
  incomeEditButton: {
    minHeight: 44, paddingHorizontal: 12, borderRadius: 7,
    justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.forest,
  },
  incomeEditButtonPressed: { backgroundColor: '#17352c' },
  detailHero: { padding: 20, gap: 10, borderRadius: 16, backgroundColor: COLORS.soft },
  detailCategory: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  detailCaption: { color: '#52655b', fontSize: 15, flexShrink: 1 },
  detailDescription: { color: COLORS.ink, fontSize: 22, fontWeight: '600' },
  detailAmount: { color: COLORS.forest, fontSize: 34, fontWeight: '700', fontVariant: ['tabular-nums'] },
  detailLedger: { gap: 10, padding: 16, borderColor: COLORS.line, borderWidth: 1, borderRadius: 12 },
  detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  detailDelete: { minHeight: 48, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  detailDeleteText: { color: '#96392f', fontSize: 16, fontWeight: '600' },
  detailEdit: { flexGrow: 1 },
  expenseHeader: {
    minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.line,
  },
  expenseTitle: { color: COLORS.ink, fontWeight: '700', fontSize: 24 },
  expenseClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  expenseCloseText: { color: COLORS.ink, fontSize: 27 },
  expenseFields: { paddingHorizontal: 16, paddingVertical: 16, gap: 16 },
  expenseLabel: { color: COLORS.ink, fontSize: 16, fontWeight: '600' },
  expenseControl: { minHeight: 48 },
  expenseTextInput: { minHeight: 48, fontSize: 17 },
  expenseFooter: { padding: 16, paddingVertical: 12, backgroundColor: COLORS.paper, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.line },
  expenseSave: { minHeight: 48, backgroundColor: COLORS.forest, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  expenseSaveText: { color: COLORS.paper, fontSize: 18, fontWeight: '700' },
  sectionHeader: { marginTop: 25, marginBottom: 10 }, sectionTitle: { color: COLORS.ink, fontSize: 18, fontWeight: '700', letterSpacing: -.25 }, listCard: { overflow: 'hidden', backgroundColor: COLORS.paper, borderRadius: 10, borderWidth: 1, borderColor: '#eeede7' }, movementRow: { minHeight: 64, paddingHorizontal: 11, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ecebe5', flexDirection: 'row', alignItems: 'center', gap: 9 },
  categoryMark: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#d9f3fb' },
  categoryMarkSmall: { width: 24, height: 24, borderRadius: 7 },
  categoryGlyph: { width: 24, height: 24, tintColor: '#176484' },
  categoryGlyphSmall: { width: 17, height: 17 },
  movementInfo: { flex: 1, minWidth: 0 }, movementTitle: { color: '#35423c', fontSize: 13, fontWeight: '600' }, movementSub: { marginTop: 3, color: '#99a19c', fontSize: 11 }, movementRight: { alignItems: 'flex-end', minWidth: 78 }, movementAmount: { color: '#35423c', fontSize: 13, fontWeight: '600' }, movementDate: { minWidth: 36, textAlign: 'right', color: '#8f9992', fontSize: 11 },
  tabBar: {
    minHeight: 63, backgroundColor: COLORS.paper, borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e8e7e0', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 3,
  },
  tabItem: { flex: 1, minWidth: 0, minHeight: 60, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 4 },
  tabIconFrame: { width: 50, height: 34, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  tabIconFrameActive: { backgroundColor: '#dcebd1' },
  tabIcon: { width: 26, height: 26, tintColor: '#68786f' },
  tabIconActive: { tintColor: COLORS.forest },
  tabLabel: { textAlign: 'center', color: '#68786f', fontSize: 11 },
  tabLabelActive: { color: COLORS.forest, fontWeight: '700' },
  toast: { position: 'absolute', alignSelf: 'center', borderRadius: 20, backgroundColor: '#2e5142', paddingHorizontal: 17, paddingVertical: 10, elevation: 4 }, toastText: { color: '#fffefa', fontSize: 12, fontWeight: '600' },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 16, marginBottom: 10 }, pillGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, padding: 3, backgroundColor: '#ebeae4', borderRadius: 9 }, pill: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 9, justifyContent: 'center', borderRadius: 7 }, pillActive: { backgroundColor: COLORS.paper, elevation: 1 }, pillText: { color: '#526158', fontSize: 14 }, pillTextActive: { color: '#35463c', fontWeight: '700' }, actionButton: { minHeight: 42, paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.forest, borderRadius: 8, marginTop: 14 }, actionText: { color: '#fffefa', fontSize: 13, fontWeight: '600' }, actionButtonLight: { backgroundColor: COLORS.lime, marginTop: 17 }, actionTextLight: { color: '#314539' },
  transferMark: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  receivedMark: { backgroundColor: '#e6f0e4' }, sentMark: { backgroundColor: '#f4e9e0' },
  selectorRow: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8, justifyContent: 'space-between', alignItems: 'center', marginBottom: 13 },
  savingsCard: { backgroundColor: '#e8eee2', padding: 19, borderRadius: 12 },
  savingsCardShared: { backgroundColor: '#eee9df' },
  savingsBalances: { marginTop: 12, gap: 12 },
  savingsDollarTotal: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#c6cbbf', paddingTop: 12 },
  savingsAmount: { color: '#2a4034', fontSize: 33, fontWeight: '700', letterSpacing: -.6 },
  savingsDollarAmount: { fontSize: 25 },
  periodCard: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
    backgroundColor: '#e7f4fa', borderColor: '#c5dfe9', borderWidth: 1, borderRadius: 14 },
  periodPager: { flex: 1, minWidth: 0 },
  periodPage: { minHeight: 46, paddingHorizontal: 4, paddingVertical: 1, alignItems: 'center', justifyContent: 'center' },
  periodMonth: { textTransform: 'capitalize', textAlign: 'center', color: '#185674', fontSize: 21, fontWeight: '700' },
  periodArrow: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.paper, alignItems: 'center', justifyContent: 'center' },
  periodArrowText: { color: '#185674', fontSize: 27, lineHeight: 32 },
  analysisSelectors: { marginTop: 12 },
  analysisCard: { backgroundColor: COLORS.paper, borderColor: '#eeede7', borderWidth: 1, borderRadius: 10 },
  analysisTotals: { padding: 17, gap: 12 },
  analysisDollarTotal: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.line, paddingTop: 12 },
  currencyBalanceLabel: { color: '#526158', fontSize: 13, fontWeight: '600' },
  analysisAmount: { color: COLORS.ink, fontSize: 33, fontWeight: '700' },
  analysisDollarAmount: { fontSize: 25 },
  changeText: { color: '#58815e', fontSize: 11, fontWeight: '700', marginTop: 2 },
  changeUp: { color: '#ad7656' },
  chartCard: { padding: 13, gap: 14, backgroundColor: COLORS.paper, borderColor: '#eeede7', borderWidth: 1, borderRadius: 10 },
  chartRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chartBody: { flex: 1, gap: 4 },
  chartLabel: { color: '#647168', fontSize: 13 },
  chartAmountRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chartValue: { flex: 1, textAlign: 'right', color: COLORS.ink, fontSize: 12, fontWeight: '600' },
  track: { width: '48%', height: 5, backgroundColor: '#f0efe9', borderRadius: 4 },
  fill: { height: 5, borderRadius: 4 },
  empty: { padding: 28, alignItems: 'center', gap: 5 }, emptySpark: { color: '#a8bd83', fontSize: 18 }, emptyTitle: { color: COLORS.ink, fontSize: 14, fontWeight: '600' }, emptyBody: { color: '#8c9790', fontSize: 11, textAlign: 'center' },
  modalSheet: { paddingHorizontal: 18, paddingBottom: 22, backgroundColor: COLORS.paper, borderTopLeftRadius: 18, borderTopRightRadius: 18 }, modalHandle: { alignSelf: 'center', marginTop: 9, width: 35, height: 4, borderRadius: 2, backgroundColor: '#dedfd8' }, modalHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 17 }, modalTitle: { color: COLORS.ink, fontSize: 20, fontWeight: '700' }, modalClose: { width: 29, height: 29, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.line, borderRadius: 15 }, formContent: { gap: 13, paddingBottom: 8 }, field: { gap: 6 }, fieldLabel: { color: '#647269', fontSize: 12, fontWeight: '600' }, amountInput: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderColor: '#e4e5df', borderWidth: 1, borderRadius: 8, backgroundColor: '#faf9f5' }, currencyPrefix: { color: '#8b978d', fontSize: 14 }, amountTextInput: { flex: 1, paddingVertical: 8, color: COLORS.ink, fontSize: 19, fontWeight: '600' }, currencyCode: { color: '#909a92', fontSize: 11, fontWeight: '600' }, textInput: { minHeight: 42, paddingHorizontal: 11, paddingVertical: 9, color: COLORS.ink, fontSize: 13, borderColor: '#e4e5df', borderWidth: 1, borderRadius: 8, backgroundColor: '#faf9f5' }, dateButton: { minHeight: 43, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8, borderColor: '#e4e5df', borderWidth: 1, borderRadius: 8, backgroundColor: '#faf9f5' }, dateValue: { color: COLORS.ink, fontSize: 13, fontWeight: '600' }, dateFull: { color: '#929d94', fontSize: 11 }, dateCalendar: { marginLeft: 'auto', color: '#617464' }, dateDone: { alignItems: 'flex-end', paddingVertical: 8 }, dateDoneText: { color: COLORS.forest, fontSize: 13, fontWeight: '700' },
  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChoice: {
    width: '31%', minHeight: 70, paddingVertical: 6, paddingHorizontal: 3,
    alignItems: 'center', justifyContent: 'center', gap: 4, borderWidth: 2,
    borderColor: 'transparent', borderRadius: 12, backgroundColor: COLORS.canvas,
  },
  categoryChoiceActive: { borderColor: COLORS.forest, backgroundColor: COLORS.soft },
  categoryChoiceText: { color: COLORS.ink, fontSize: 14, fontWeight: '500', textAlign: 'center' },
  categoryHeading: { gap: 10 },
  categoryBack: { alignSelf: 'flex-start', minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 4, borderRadius: 10, borderWidth: 1,
    borderColor: '#c5dfe9', backgroundColor: '#e7f4fa' },
  categoryBackArrow: { color: '#185674', fontSize: 28, lineHeight: 32 },
  categoryBackText: { color: '#185674', fontSize: 15, fontWeight: '700', flexShrink: 1 },
  categoryChevron: { position: 'absolute', right: 6, top: 1, color: COLORS.forest, fontSize: 17 },
  sharedButton: {
    minHeight: 48, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: '#aab7ad',
    alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.paper,
  },
  sharedButtonActive: { backgroundColor: COLORS.forest, borderColor: COLORS.forest },
  sharedButtonTextActive: { color: COLORS.paper },
  toggleActive: { backgroundColor: '#d9eccd', borderColor: '#77976e' },
  toggleTextActive: { color: COLORS.forest },
  savingKindRow: { flexDirection: 'row', gap: 8 },
  savingKindOption: { flex: 1 },
  formButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 2 }, cancelButton: { minHeight: 41, paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center', borderColor: COLORS.line, borderWidth: 1, borderRadius: 8 }, cancelText: { color: '#7b8780', fontSize: 12 }, saveButton: { minHeight: 41, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: COLORS.forest }, saveButtonDisabled: { opacity: .4 }, saveText: { color: '#fffefa', fontSize: 12, fontWeight: '600' }, formHint: { color: '#929d94', fontSize: 11 }, savingContext: { flexDirection: 'row', justifyContent: 'space-between', gap: 6, padding: 10, backgroundColor: '#f0f3eb', borderRadius: 7 }, savingContextText: { color: '#6d7d70', fontSize: 11 }, savingContextValue: { color: '#526b58', fontSize: 11, fontWeight: '600' },
});
