import { createElement, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SafeAreaModal } from './SafeAreaModal';
import { CATEGORIES, CATEGORY_GROUPS, CATEGORY_PICKER } from './domain';
import type { PersonId } from './domain';
import {
  applySearchSuggestion, expenseSearchSuggestions,
  searchCategoryLabel, searchDateLabel, searchDateRange, validSearchRange,
} from './expenseSearch';
import type { ExpenseSearch } from './expenseSearch';

type Names = Record<PersonId, string>;
type Props = { value: ExpenseSearch; names: Names; onChange: (next: ExpenseSearch) => void; onInteract: () => void; autoFocus?: boolean };

function SearchIcon() {
  return <View accessible={false} style={s.magnifier}><View style={s.lens}/><View style={s.handle}/></View>;
}

export function ExpenseSearchToggle({ expanded, active, onPress, onInteract }: {
  expanded: boolean; active: boolean; onPress: () => void; onInteract: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={expanded ? 'Ocultar buscador' : 'Buscar gastos'}
    accessibilityState={{ expanded }} onPress={onPress} onTouchStart={onInteract}
    style={({ pressed }) => [s.toggle, (expanded || active) && s.toggleActive, pressed && s.pressed]}>
    <SearchIcon/>
    {active && <View style={s.activeDot}/>}
  </Pressable>;
}

export function ExpenseSearchBar({ value, names, onChange, onInteract, autoFocus = false }: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const suggestions = useMemo(() => expenseSearchSuggestions(value.query, names)
    .filter(item => item.kind === 'payer' ? item.value !== value.payer
      : item.kind === 'category' ? item.value !== value.category : true), [names, value]);
  const filterCount = Number(!!value.payer) + Number(!!value.category) + Number(!!value.date);

  return <View style={s.search} onTouchStart={onInteract}>
    <View style={s.searchRow}>
      <View style={s.inputShell}>
        <View style={s.inputIcon}><SearchIcon/></View>
        <TextInput value={value.query} onChangeText={query => onChange({ ...value, query })}
          accessibilityLabel="Buscar gastos por persona, categoría, descripción o fecha" placeholder="Buscar gastos…"
          placeholderTextColor="#6c7a70" style={s.input} autoCorrect={false} autoCapitalize="none" autoFocus={autoFocus}
          returnKeyType="search" onSubmitEditing={Keyboard.dismiss} maxLength={200}/>
        {!!value.query && <Pressable accessibilityRole="button" accessibilityLabel="Borrar texto de búsqueda"
          onPress={() => onChange({ ...value, query: '' })} style={s.clear}><Text style={s.clearText}>×</Text></Pressable>}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={filterCount ? `Filtros, ${filterCount} activos` : 'Abrir filtros de gastos'}
        onPress={() => { Keyboard.dismiss(); setFiltersOpen(true); }} style={s.filterButton}>
        <Text style={s.filterText}>Filtros{filterCount ? ` · ${filterCount}` : ''}</Text>
      </Pressable>
    </View>
    {(value.payer || value.category || value.date) && <View style={s.chips}>
      {value.payer && <FilterChip label={`Pagó ${names[value.payer]}`} onRemove={() => onChange({ ...value, payer: undefined })}/>}
      {value.category && <FilterChip label={searchCategoryLabel(value.category)} onRemove={() => onChange({ ...value, category: undefined })}/>}
      {value.date && <FilterChip label={searchDateLabel(value.date)} onRemove={() => onChange({ ...value, date: undefined })}/>}
    </View>}
    {!!suggestions.length && <View style={s.suggestions}>
      <Text style={s.hint}>Sugerencias</Text>
      <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={s.suggestionRow}>
        {suggestions.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Filtrar por ${item.label}`}
          onPress={() => { onChange(applySearchSuggestion(value, item)); Keyboard.dismiss(); }} style={s.suggestion}>
          <Text style={s.suggestionKind}>{item.kind === 'payer' ? 'PERSONA' : item.kind === 'date' ? 'FECHA' : 'CATEGORÍA'}</Text>
          <Text style={s.suggestionText}>{item.label}</Text>
        </Pressable>)}
      </ScrollView>
    </View>}
    {filtersOpen && <ExpenseSearchFilters initial={value} names={names} onClose={() => setFiltersOpen(false)}
      onApply={next => { onChange({ ...value, payer: next.payer, category: next.category, date: next.date }); setFiltersOpen(false); }}/>} 
  </View>;
}

export function ExpenseSearchSummary({ count, pending, onClear }: { count: number; pending: boolean; onClear: () => void }) {
  return <View style={s.summary}>
    <Text accessibilityLiveRegion="polite" style={s.hint}>{pending ? 'Buscando…' : `${count} ${count === 1 ? 'registro encontrado' : 'registros encontrados'}`}</Text>
    <Pressable accessibilityRole="button" onPress={onClear} style={s.clearAll}><Text style={s.clearAllText}>Limpiar búsqueda</Text></Pressable>
  </View>;
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Quitar filtro: ${label}`} onPress={onRemove} style={s.chip}>
    <Text style={s.chipText}>{label}</Text><Text style={s.chipClose}>×</Text>
  </Pressable>;
}

function FilterChoice({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress}
    style={({ pressed }) => [s.choice, active && s.choiceActive, pressed && s.pressed]}>
    <Text style={[s.choiceText, active && s.choiceTextActive]}>{label}</Text>
  </Pressable>;
}

function ExpenseSearchFilters({ initial, names, onApply, onClose }: {
  initial: ExpenseSearch; names: Names; onApply: (next: ExpenseSearch) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<ExpenseSearch>(() => ({ ...initial }));
  const groupId = CATEGORY_GROUPS.find(item => item.id === draft.category)?.id
    ?? CATEGORIES.find(item => item.id === draft.category)?.group;
  const group = CATEGORY_GROUPS.find(item => item.id === groupId);
  const range = searchDateRange(draft.date);
  const validRange = validSearchRange(draft.date);
  function isMonth(offset: number) {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() + offset);
    return draft.date?.kind === 'month' && draft.date.month === date.getMonth() + 1 && draft.date.year === date.getFullYear();
  }
  function changeBound(bound: 'from' | 'to', value: string) {
    const next = { ...range, [bound]: value };
    setDraft(current => ({ ...current, date: next.from || next.to ? { kind: 'range', ...next } : undefined }));
  }
  function selectMonth(offset: number) {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() + offset);
    setDraft(current => ({ ...current, date: { kind: 'month', month: date.getMonth() + 1, year: date.getFullYear() } }));
  }

  return <SafeAreaModal visible presentationStyle="fullScreen" animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={s.modal}>
      <View style={s.header}><Text accessibilityRole="header" style={s.title}>Filtrar gastos</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Cerrar filtros sin aplicar" onPress={onClose} style={s.close}>
          <Text style={s.closeText}>×</Text></Pressable></View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.fields}>
        <View style={s.field}>
          <Text style={s.label}>Pagó</Text><View style={s.choices}>
            <FilterChoice label="Cualquiera" active={!draft.payer} onPress={() => setDraft(current => ({ ...current, payer: undefined }))}/>
            {(['adri', 'mel'] as const).map(person => <FilterChoice key={person} label={names[person]} active={draft.payer === person}
              onPress={() => setDraft(current => ({ ...current, payer: person }))}/>)}
          </View>
        </View>
        <View style={s.field}>
          <Text style={s.label}>Categoría</Text><View style={s.choices}>
            <FilterChoice label="Todas" active={!draft.category} onPress={() => setDraft(current => ({ ...current, category: undefined }))}/>
            {CATEGORY_PICKER.map(item => <FilterChoice key={item.id} label={item.label} active={draft.category === item.id || groupId === item.id}
              onPress={() => setDraft(current => ({ ...current, category: item.id }))}/>)}
          </View>
          {group && <View style={s.subcategories}>
            <Text style={s.hint}>{group.label}</Text><View style={s.choices}>
              <FilterChoice label={`Todo ${group.label}`} active={draft.category === group.id}
                onPress={() => setDraft(current => ({ ...current, category: group.id }))}/>
              {group.children.map(item => <FilterChoice key={item.id} label={item.label} active={draft.category === item.id}
                onPress={() => setDraft(current => ({ ...current, category: item.id }))}/>)}
            </View>
          </View>}
        </View>
        <View style={s.field}>
          <Text style={s.label}>Período</Text><View style={s.choices}>
            <FilterChoice label="Todo el historial" active={!draft.date} onPress={() => setDraft(current => ({ ...current, date: undefined }))}/>
            <FilterChoice label="Este mes" active={isMonth(0)} onPress={() => selectMonth(0)}/>
            <FilterChoice label="Mes anterior" active={isMonth(-1)} onPress={() => selectMonth(-1)}/>
          </View>
          {!!draft.date && <Text style={s.dateHint}>{searchDateLabel(draft.date)}</Text>}
          <View style={s.dateFields}>
            <SearchDateField label="Desde" value={range.from} onChange={value => changeBound('from', value)} defaultDate={range.to}/>
            <SearchDateField label="Hasta" value={range.to} onChange={value => changeBound('to', value)} defaultDate={range.from}/>
          </View>
          {!validRange && <Text accessibilityLiveRegion="polite" style={s.error}>La fecha de inicio tiene que ser anterior o igual a la fecha de fin.</Text>}
        </View>
      </ScrollView>
      <View style={s.footer}>
        {(draft.payer || draft.category || draft.date) && <Pressable accessibilityRole="button"
          onPress={() => setDraft({ query: initial.query })} style={s.reset}><Text style={s.clearAllText}>Quitar filtros</Text></Pressable>}
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !validRange }} disabled={!validRange}
          onPress={() => onApply(draft)} style={[s.apply, !validRange && s.disabled]}><Text style={s.applyText}>Ver gastos</Text></Pressable>
      </View>
    </SafeAreaView>
  </SafeAreaModal>;
}

function SearchDateField({ label, value, defaultDate, onChange }: {
  label: string; value: string; defaultDate: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const date = value || defaultDate;
  const selected = date ? new Date(`${date}T12:00:00`) : new Date();
  return <View style={s.dateField}><Text style={s.hint}>{label}</Text>
    {Platform.OS === 'web' ? createElement('input', {
      type: 'date', value, 'aria-label': label, onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
      style: { boxSizing: 'border-box', width: '100%', minWidth: 0, minHeight: 50, border: '1px solid #dedfd7', borderRadius: 12,
        padding: '10px', fontFamily: 'inherit', fontSize: 16, color: '#26342f', backgroundColor: '#fffefa' },
    }) : <>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value || 'Elegir fecha'}`} onPress={() => setOpen(true)} style={s.dateButton}>
        <Text style={s.choiceText}>{value ? value.split('-').reverse().join('/') : 'Elegir fecha'}</Text>
      </Pressable>
      {open && <DateTimePicker value={selected} mode="date" display={Platform.OS === 'ios' ? 'spinner' : 'default'}
        onChange={(event, next) => {
          if (Platform.OS !== 'ios') setOpen(false);
          if (event.type === 'set' && next) onChange(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`);
        }}/>} 
      {open && Platform.OS === 'ios' && <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={s.reset}><Text style={s.clearAllText}>Listo</Text></Pressable>}
    </>}
    {!!value && <Pressable accessibilityRole="button" accessibilityLabel={`Quitar fecha ${label.toLowerCase()}`}
      onPress={() => onChange('')} style={s.dateClear}><Text style={s.clearAllText}>Quitar</Text></Pressable>}
  </View>;
}

const s = StyleSheet.create({
  search: { gap: 10, marginBottom: 12 }, searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inputShell: { flex: 1, minWidth: 0, minHeight: 52, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#dedfd7', borderRadius: 14, backgroundColor: '#fffefa' },
  toggle: { width: 44, height: 44, marginLeft: 'auto', borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  toggleActive: { backgroundColor: '#e5f1f8' }, activeDot: { position: 'absolute', width: 6, height: 6, borderRadius: 3, top: 6, right: 6, backgroundColor: '#176484' },
  inputIcon: { marginLeft: 13, marginRight: 7 }, magnifier: { width: 22, height: 22 }, lens: { width: 15, height: 15, borderRadius: 8, borderWidth: 2, borderColor: '#64776c' },
  handle: { position: 'absolute', left: 13, top: 14, width: 8, height: 2, borderRadius: 1, backgroundColor: '#64776c', transform: [{ rotate: '45deg' }] },
  input: { flex: 1, minWidth: 0, minHeight: 50, color: '#26342f', fontSize: 17, paddingVertical: 10, paddingRight: 5 },
  clear: { minWidth: 42, minHeight: 48, alignItems: 'center', justifyContent: 'center' }, clearText: { color: '#64776c', fontSize: 27 },
  filterButton: { minHeight: 52, justifyContent: 'center', backgroundColor: '#e5f1f8', paddingHorizontal: 14, borderRadius: 14 },
  filterText: { fontSize: 16, color: '#176484', fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, chip: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, minHeight: 44, maxWidth: '100%', borderRadius: 12, backgroundColor: '#e5f1f8' },
  chipText: { flexShrink: 1, color: '#176484', fontSize: 15, fontWeight: '600' }, chipClose: { fontSize: 24, color: '#176484' },
  suggestions: { gap: 6 }, hint: { fontSize: 14, lineHeight: 21, color: '#64776c' }, suggestionRow: { gap: 8 },
  suggestion: { minHeight: 54, paddingHorizontal: 13, paddingVertical: 8, gap: 2, borderWidth: 1, borderColor: '#dedfd7', borderRadius: 12, backgroundColor: '#fffefa' },
  suggestionKind: { fontSize: 10, fontWeight: '600', letterSpacing: .7, color: '#64776c' }, suggestionText: { fontSize: 16, fontWeight: '600', color: '#21463b' },
  summary: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 6 },
  clearAll: { minHeight: 44, justifyContent: 'center' }, clearAllText: { color: '#176484', fontSize: 15, fontWeight: '600' },
  modal: { flex: 1, backgroundColor: '#fffefa' }, header: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: '#e8e7e0', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { flexShrink: 1, fontSize: 24, fontWeight: '700', color: '#26342f' }, close: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }, closeText: { fontSize: 36, color: '#26342f' },
  fields: { padding: 16, gap: 26, paddingBottom: 28 }, field: { gap: 12 }, label: { fontSize: 19, fontWeight: '700', color: '#26342f' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, choice: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: '#dedfd7', backgroundColor: '#f5f4ef' },
  choiceActive: { borderColor: '#176484', backgroundColor: '#e5f1f8' }, choiceText: { fontSize: 16, color: '#526158' }, choiceTextActive: { color: '#176484', fontWeight: '700' }, pressed: { opacity: .7 },
  subcategories: { padding: 12, borderRadius: 14, gap: 10, backgroundColor: '#f5f4ef' }, dateHint: { fontSize: 15, color: '#176484' },
  dateFields: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, dateField: { flexGrow: 1, flexBasis: 145, minWidth: 0, gap: 6 },
  dateButton: { minHeight: 50, borderWidth: 1, borderColor: '#dedfd7', borderRadius: 12, paddingHorizontal: 12, justifyContent: 'center' },
  dateClear: { minHeight: 40, justifyContent: 'center', alignItems: 'flex-start' }, error: { color: '#9e342c', fontSize: 15, lineHeight: 22 },
  footer: { padding: 16, paddingTop: 12, gap: 6, borderTopWidth: 1, borderColor: '#e8e7e0' }, reset: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  apply: { minHeight: 52, borderRadius: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: '#21463b' }, applyText: { fontSize: 18, fontWeight: '700', color: '#fffefa' }, disabled: { opacity: .4 },
});
