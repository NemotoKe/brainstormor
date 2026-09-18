'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = require('../src/model.js');
const F = require('../src/features.js');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function documentWith(elements) { return { ...M.createDocument(), elements }; }
function almostEqual(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`); }

test('all advertised templates have useful compact layouts, fresh IDs, and survive saving', () => {
  assert.deepEqual(F.templates.map(item => [item.id, item.title, item.kind]), [
    ['mindmap', 'アイデアマップ', 'mindmap'], ['flow', '判断フロー', 'flow'], ['retro', 'ふりかえり', 'retro']
  ]);
  const previousIds = new Set();
  for (const metadata of F.templates) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const doc = F.createTemplate(metadata.id);
      assert.equal(doc.title, metadata.title);
      assert.ok(doc.elements.length >= 8 && doc.elements.length <= 15);
      assert.deepEqual(M.parse(M.serialize(doc)), doc);
      const bounds = M.getBounds(doc.elements);
      assert.equal(bounds.x, 0); assert.equal(bounds.y, 0);
      assert.ok(bounds.width >= 900 && bounds.width <= 1100);
      assert.ok(bounds.height >= 500 && bounds.height <= 700);
      const items = new Map(doc.elements.map(item => [item.id, item]));
      for (const item of doc.elements) {
        assert.ok(!previousIds.has(item.id), 'templates must not share IDs'); previousIds.add(item.id);
        if (item.type === 'arrow') {
          assert.ok(items.has(item.from.elementId)); assert.ok(items.has(item.to.elementId));
        } else assert.ok(item.text.length > 0, 'template objects should be editable prompts');
      }
    }
  }
  assert.throws(() => F.createTemplate('unknown'), /テンプレート/);
});

test('feature module works as a browser global without DOM or CommonJS', () => {
  const context = vm.createContext({ TextEncoder, atob });
  vm.runInContext(fs.readFileSync(require.resolve('../src/model.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../src/features.js'), 'utf8'), context);
  assert.equal(context.BrainstormorFeatures.createTemplate('mindmap').title, 'アイデアマップ');
  assert.equal(context.BrainstormorFeatures.searchElements([{ id: 'a', text: 'ＡＢＣ' }], 'abc')[0], 'a');
});

test('branches preserve appearance, use requested directions, and bind a fresh child without mutating input', () => {
  for (const type of ['rect', 'ellipse', 'diamond', 'note']) {
    for (const direction of ['right', 'down', 'left', 'up']) {
      const source = M.createItem(type, { id: 'source', x: 40, y: 60, width: 275, height: 160, text: '親のアイデア', color: '#137b6b', textColor: '#ffffff', fontSize: 27 });
      const elements = freeze([source]);
      const [child, arrow] = F.branchElements(elements, source.id, direction);
      assert.notEqual(child.id, source.id); assert.notEqual(arrow.id, child.id);
      assert.equal(child.text, '新しいアイデア');
      for (const key of ['type', 'color', 'textColor', 'fontSize', 'width', 'height']) assert.equal(child[key], source[key]);
      if (direction === 'right') { assert.equal(child.x - source.x - source.width, 100); assert.equal(child.y, source.y); }
      if (direction === 'left') { assert.equal(source.x - child.x - child.width, 100); assert.equal(child.y, source.y); }
      if (direction === 'down') { assert.equal(child.y - source.y - source.height, 100); assert.equal(child.x, source.x); }
      if (direction === 'up') { assert.equal(source.y - child.y - child.height, 100); assert.equal(child.x, source.x); }
      assert.equal(arrow.from.elementId, source.id); assert.equal(arrow.to.elementId, child.id);
      assert.deepEqual(M.parse(M.serialize(documentWith([...elements, child, arrow]))).elements, [...elements, child, arrow]);
      assert.equal(source.text, '親のアイデア'); assert.equal(elements.length, 1);
    }
  }
});

test('branch collision avoidance considers all boxes and repeated branches while ignoring arrows', () => {
  const source = M.createItem('rect', { id: 'source', width: 200, height: 120 });
  const image = M.createItem('image', { x: 300, y: -50, width: 200, height: 180 });
  const text = M.createItem('text', { x: 290, y: 150, width: 300, height: 100, text: '邪魔しないで' });
  const freeArrow = M.createItem('arrow', { x: 0, y: 0, width: 99999, height: 99999 });
  let elements = [source, image, text, freeArrow];
  for (let index = 0; index < 6; index++) {
    const before = M.clone(elements);
    const [child, arrow] = F.branchElements(freeze(elements), source.id);
    assert.equal(child.x, source.x + source.width + 100);
    for (const obstacle of elements.filter(item => item.type !== 'arrow')) assert.ok(!overlaps(child, obstacle));
    assert.deepEqual(elements, before);
    elements = [...elements, child, arrow];
  }
  assert.equal(F.branchElements(elements, source.id, 'sideways').length, 0);
  for (const item of [image, text, freeArrow]) assert.deepEqual(F.branchElements(elements, item.id), []);
  assert.deepEqual(F.branchElements(elements, 'missing'), []);
});

test('vertical branches avoid a wide obstacle by moving only along the horizontal axis', () => {
  const source = M.createItem('note', { id: 'source', x: -200, y: -150, width: 220, height: 150 });
  const obstacle = M.createItem('rect', { x: -500, y: 100, width: 1500, height: 600 });
  const [child] = F.branchElements(freeze([source, obstacle]), source.id, 'down');
  assert.equal(child.y, 100); assert.ok(child.x >= obstacle.x + obstacle.width);
  assert.ok(!overlaps(child, obstacle));
});

test('alignment uses outer bounds, ignores arrows, and keeps connections and unselected items intact', () => {
  const a = M.createItem('rect', { id: 'a', x: 10, y: 20, width: 120, height: 80 });
  const b = M.createItem('image', { id: 'b', x: 250, y: 150, width: 200, height: 160 });
  const c = M.createItem('text', { id: 'c', x: -80, y: 380, width: 100, height: 60, text: 'メモ' });
  const untouched = M.createItem('note', { id: 'untouched', x: 700 });
  const arrow = M.createItem('arrow', { id: 'arrow', from: { x: 0, y: 0, elementId: 'a' }, to: { x: 0, y: 0, elementId: 'b' } });
  const elements = freeze([a, b, arrow, c, untouched]);
  const expected = { left: -80, center: 185, right: 450, top: 20, middle: 230, bottom: 440 };
  for (const mode of Object.keys(expected)) {
    const result = F.alignElements(elements, new Set(['a', 'b', 'c', 'arrow']), mode);
    assert.notEqual(result, elements);
    assert.deepEqual(result.map(item => item.id), elements.map(item => item.id));
    assert.equal(result[2], arrow); assert.equal(result[4], untouched);
    for (const item of result.filter(item => ['a', 'b', 'c'].includes(item.id))) {
      const actual = mode === 'left' ? item.x : mode === 'center' ? item.x + item.width / 2 : mode === 'right' ? item.x + item.width
        : mode === 'top' ? item.y : mode === 'middle' ? item.y + item.height / 2 : item.y + item.height;
      almostEqual(actual, expected[mode]);
    }
    assert.equal(result[2].from.elementId, 'a'); assert.equal(result[2].to.elementId, 'b');
    assert.deepEqual(M.parse(M.serialize(documentWith(result))).elements, result);
  }
  assert.equal(a.x, 10); assert.equal(b.y, 150); assert.equal(c.x, -80);
});

test('distribution gives unequal boxes equal edge gaps and leaves the outermost boxes fixed', () => {
  for (const [mode, axis, size, otherAxis] of [['distribute-x', 'x', 'width', 'y'], ['distribute-y', 'y', 'height', 'x']]) {
    const items = [
      M.createItem('rect', { id: 'first', [axis]: 10, [size]: 100, [otherAxis]: 42 }),
      M.createItem('rect', { id: 'second', [axis]: 190, [size]: 250, [otherAxis]: 82 }),
      M.createItem('rect', { id: 'third', [axis]: 620, [size]: 60, [otherAxis]: 123 }),
      M.createItem('rect', { id: 'last', [axis]: 900, [size]: 180, [otherAxis]: 321 })
    ];
    const elements = freeze([items[2], items[0], items[3], items[1]]);
    const result = F.alignElements(elements, ['last', 'third', 'first', 'second'], mode);
    assert.deepEqual(result.map(item => item.id), elements.map(item => item.id));
    const ordered = result.slice().sort((a, b) => a[axis] - b[axis]);
    assert.equal(ordered[0], items[0]); assert.equal(ordered[3], items[3]);
    const gaps = ordered.slice(1).map((item, index) => item[axis] - ordered[index][axis] - ordered[index][size]);
    gaps.forEach(gap => almostEqual(gap, gaps[0]));
    for (const item of ordered) assert.equal(item[otherAxis], items.find(original => original.id === item.id)[otherAxis]);
  }
});

test('alignment with too few boxes or unknown mode leaves geometry unchanged', () => {
  const a = M.createItem('rect', { id: 'a' }), b = M.createItem('note', { id: 'b', x: 500 });
  const arrow = M.createItem('arrow', { id: 'arrow' });
  const elements = freeze([a, arrow, b]);
  for (const [ids, mode] of [[['a', 'arrow'], 'left'], [['a', 'b', 'arrow'], 'distribute-x'], [[], 'top'], [['a', 'b'], 'unknown']]) {
    const result = F.alignElements(elements, ids, mode);
    assert.notEqual(result, elements); assert.deepEqual(result, elements);
  }
});

test('search matches Unicode compatibility forms, case, text, and arrow labels in document order', () => {
  const elements = freeze([
    { id: 'a', type: 'rect', text: 'ＡＰＩを考える' },
    { id: 'b', type: 'note', text: 'api の案\nカタカナ' },
    { id: 'c', type: 'text', text: '別のテーマ' },
    { id: 'd', type: 'arrow', label: 'API 成功時' },
    { id: 'e', type: 'image', name: 'API.png' },
    { id: 'f', type: 'arrow' }
  ]);
  assert.deepEqual(F.searchElements(elements, '　 aPi　'), ['a', 'b', 'd']);
  assert.deepEqual(F.searchElements(elements, 'ｶﾀｶﾅ'), ['b']);
  assert.deepEqual(F.searchElements(elements, '成功'), ['d']);
  for (const query of ['', '　 \n', null, undefined, '存在しない']) assert.deepEqual(F.searchElements(elements, query), []);
});

test('branch collision checks use the final text-fitted dimensions', () => {
  const source = M.createItem('rect', { x: 0, y: 0, width: 100, height: 70 });
  const obstacle = M.createItem('rect', { x: 200, y: 100, width: 100, height: 80 });
  const [child] = F.branchElements([source, obstacle], source.id, 'right', { width: 100, height: 119 });
  assert.equal(child.height, 119);
  assert.equal(overlaps(child, obstacle), false);
  const [upper] = F.branchElements([source], source.id, 'up', { width: 100, height: 119 });
  assert.equal(source.y - upper.y - upper.height, 100);
});
