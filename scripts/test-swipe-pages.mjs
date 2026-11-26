import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual component's hooks and native event handlers. Android may
// clamp scrollTo to zero until its children's content-size event arrives.
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function SwipePages('), app.indexOf('function CategoryMark('));
assert.ok(source.startsWith('function SwipePages('));
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
} });
function mount(page, count, resetKey) {
  const slots = []; let cursor = 0, effects = [], tree;
  let nativeWidth = 0, offset = 0;
  const calls = [], changes = [];
  let props = { page, resetKey, onPageChange: index => changes.push(index),
    pages: Array.from({ length: count }, (_, index) => ({ key: String(index), content: String(index) })) };
  const scroll = { scrollTo(value) { calls.push(value); offset = Math.max(0, Math.min(value.x, nativeWidth - width())); } };
  const context = {
    React: { createElement: (type, attributes, ...children) => ({ type, props: attributes ?? {}, children }) },
    View: 'View', ScrollView: 'ScrollView', styles: {},
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useLayoutEffect(effect, deps) { const index = cursor++; const previous = slots[index];
      if (!previous || deps.some((value, at) => value !== previous[at])) effects.push(effect);
      slots[index] = deps; },
  };
  vm.createContext(context); vm.runInContext(outputText, context);
  function width() { return slots[0]; }
  function native() { return tree.children.flat().find(child => child?.type === 'ScrollView'); }
  function render() { cursor = 0; effects = []; tree = context.SwipePages(props);
    native().props.ref.current = scroll; effects.forEach(effect => effect()); }
  render();
  return {
    calls, changes,
    get offset() { return offset; },
    layout(next) { tree.props.onLayout({ nativeEvent: { layout: { width: next } } }); render(); },
    content() { nativeWidth = width() * count; native().props.onContentSizeChange?.(nativeWidth, 200); },
    select(next, key = props.resetKey) { props = { ...props, page: next, resetKey: key }; render(); },
    swipe(next) { native().props.onScrollBeginDrag(); offset = next * width();
      native().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: offset } } }); },
    momentum() { native().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: offset } } }); },
  };
}
for (const [label, page, count] of [
  ['Ahorros compartido', 1, 2], ['Gastos compartidos', 1, 3], ['Gastos personales', 2, 3],
  ['Analisis compartidos', 1, 2], ['Mes seleccionado en Vencimientos y Analisis', 1, 3], ['Balance USD', 1, 2],
]) {
  for (let visit = 0; visit < 2; visit++) {
    const view = mount(page, count);
    view.layout(360); // View layout precedes the native scroll content layout.
    view.content();
    assert.equal(view.offset, page * 360, label + ': selection and visible page differ after mount/remount');
    assert.equal(view.calls.at(-1).animated, false, 'Restoring a page must not animate from another account');
    assert.equal(view.changes.length, 0, 'Restoration must not change the selected option');
    view.layout(400); view.content();
    assert.equal(view.offset, page * 400, label + ': resize lost the selected page');
  }
}
const view = mount(0, 3);
view.layout(360); view.content();
view.select(2);
assert.equal(view.offset, 720);
assert.equal(view.calls.at(-1).animated, true, 'Selecting a pill should preserve sliding animation');
view.momentum(); assert.equal(view.changes.length, 0, 'Programmatic scrolling changed the filter');
view.swipe(1); assert.equal(view.changes.at(-1), 1);
view.select(1); assert.equal(view.offset, 360);
view.select(0); assert.equal(view.offset, 0);
const month = mount(1, 3, '2026-11');
month.layout(360); month.content(); month.swipe(2); month.select(1, '2026-12');
assert.equal(month.offset, 360, 'Month carousel did not recenter after changing month');
assert.equal(month.calls.at(-1).animated, false);
console.log('Carruseles: regreso a pestanas, selecciones, giro de pantalla, gestos y cambio de mes OK.');
