'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../src/model.js');

function board(...elements) {
  const doc = model.createDocument('アイデア 🧠\n画像に文字を載せる');
  doc.elements = elements;
  return doc;
}
function parseObject(doc) { return model.parse(JSON.stringify(doc)); }

test('all element types and Unicode content round trip without losing embedded images or viewport', () => {
  const note = model.createItem('note', { id: 'note', x: -42.5, text: '猫\n考える <script> ✨', color: '#FFCC00' });
  const text = model.createItem('text', { id: 'text', x: 111, y: 222, text: '画像の上に文字', fontSize: 36 });
  const image = model.createItem('image', { id: 'image', name: '参照.png' });
  const arrow = model.createItem('arrow', { from: { x: 4, y: 5, elementId: 'note' }, to: { x: 8, y: 9, elementId: 'image' }, strokeWidth: 2.5 });
  const doc = board(image, note, text, arrow);
  doc.viewport = { x: -12.34, y: 99.1, zoom: 1.75 };
  assert.deepEqual(model.parse(model.serialize(doc)), doc);
  assert.match(model.serialize(doc), /\n  "format"/);
  assert.deepEqual(model.parse('\ufeff' + model.serialize(doc)), doc);
});

test('standalone browser global works without CommonJS or dependencies', () => {
  const context = vm.createContext({ TextEncoder, atob });
  vm.runInContext(fs.readFileSync(require.resolve('../src/model.js'), 'utf8'), context);
  const api = context.BrainstormorModel;
  assert.equal(api.parse(api.serialize(api.createDocument())).title, '無題のボード');
  assert.equal(api.createItem('image').type, 'image');
});

test('new IDs are unique and clones do not retain nested references', () => {
  const ids = Array.from({ length: 100 }, () => model.createItem('note').id);
  assert.equal(new Set(ids).size, ids.length);
  const original = board(model.createItem('arrow'));
  const copy = model.clone(original);
  copy.elements[0].from.x = 42;
  assert.equal(original.elements[0].from.x, 0);
});

test('malformed imports fail without modifying the existing document', () => {
  const existing = board(model.createItem('note', { text: '失ってはいけない内容' }));
  const before = model.serialize(existing);
  const invalid = [null, [], {}, { ...existing, format: 'other' }, { ...existing, version: 2 }, { ...existing, title: 1 }, { ...existing, viewport: { x: 0, y: 0, zoom: 0 } }, { ...existing, elements: {} }];
  for (const value of invalid) assert.throws(() => parseObject(value));
  assert.throws(() => model.parse('{broken JSON'));
  assert.throws(() => model.parse(42));
  assert.equal(model.serialize(existing), before);
});

test('rejects invalid geometry, colors, text, duplicate IDs and unknown element types', () => {
  const item = model.createItem('note');
  const overrides = [{ x: Infinity }, { y: '3' }, { width: -1 }, { height: 0 }, { color: 'url(javascript:alert(1))' }, { fontSize: 0 }, { text: {} }, { type: 'script' }, { id: '' }, { x: model.LIMITS.coordinate + 1 }];
  for (const changes of overrides) assert.throws(() => parseObject(board({ ...item, ...changes })));
  assert.throws(() => parseObject(board(item, { ...item })));
  assert.throws(() => model.serialize(board({ ...item, x: NaN })));
  assert.throws(() => parseObject(board(model.createItem('arrow', { from: { x: 0, y: 0 } }), { ...model.createItem('arrow'), to: { x: '0', y: 0 } })));
});

test('unknown properties are stripped, with no mutation or prototype pollution', () => {
  const source = model.serialize(board(model.createItem('note')));
  const input = JSON.parse(source);
  input.extra = 'secret';
  input.elements[0].onload = 'alert(1)';
  input.viewport.secret = true;
  Object.defineProperty(input, '__proto__', { value: { polluted: true }, enumerable: true });
  const output = parseObject(input);
  assert.deepEqual(output, model.parse(source));
  assert.equal(input.elements[0].onload, 'alert(1)');
  assert.equal({}.polluted, undefined);
});

test('external, SVG, malformed and MIME-disguised image sources are rejected', () => {
  const image = model.createItem('image');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
  const invalid = ['https://example.com/image.png', 'file:///image.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,' + svg, 'data:image/png;base64,' + svg, 'data:image/png;base64,????', 'data:text/html;base64,' + svg];
  for (const src of invalid) assert.throws(() => parseObject(board({ ...image, src })));
  assert.equal(parseObject(board(image)).elements[0].src, image.src);
});

test('missing or arrow-to-arrow bindings become free endpoints, valid bindings remain', () => {
  const note = model.createItem('note', { id: 'note' });
  const a = model.createItem('arrow', { id: 'a', from: { x: 5, y: 6, elementId: 'missing' }, to: { x: 7, y: 8, elementId: 'note' } });
  const b = model.createItem('arrow', { id: 'b', from: { x: 1, y: 2, elementId: 'a' } });
  const output = parseObject(board(note, a, b));
  assert.deepEqual(output.elements[1].from, { x: 5, y: 6 });
  assert.deepEqual(output.elements[1].to, { x: 7, y: 8, elementId: 'note' });
  assert.deepEqual(output.elements[2].from, { x: 1, y: 2 });
  assert.equal(a.from.elementId, 'missing');
});

test('bound arrows meet rectangle edges and follow elements when moved', () => {
  const a = model.createItem('note', { id: 'a', x: 0, y: 0, width: 100, height: 100 });
  const b = model.createItem('note', { id: 'b', x: 300, y: 0, width: 100, height: 100 });
  const arrow = model.createItem('arrow', { from: { x: -1, y: -1, elementId: 'a' }, to: { x: -2, y: -2, elementId: 'b' } });
  assert.deepEqual(model.arrowEndpoints(arrow, [a, b]), { from: { x: 100, y: 50 }, to: { x: 300, y: 50 } });
  b.x = 0; b.y = 300;
  assert.deepEqual(model.arrowEndpoints(arrow, [a, b]), { from: { x: 50, y: 100 }, to: { x: 50, y: 300 } });
  b.x = 300;
  assert.deepEqual(model.arrowEndpoints(arrow, [a, b]), { from: { x: 100, y: 100 }, to: { x: 300, y: 300 } });
  assert.equal(arrow.from.x, -1);
});

test('one bound end, dangling binding and coincident centers produce finite endpoints', () => {
  const a = model.createItem('note', { id: 'a', width: 100, height: 100 });
  const arrow = model.createItem('arrow', { from: { x: 4, y: 5, elementId: 'a' }, to: { x: 250, y: 50 } });
  assert.deepEqual(model.arrowEndpoints(arrow, [a]), { from: { x: 100, y: 50 }, to: { x: 250, y: 50 } });
  assert.deepEqual(model.arrowEndpoints(arrow, []), { from: { x: 4, y: 5 }, to: { x: 250, y: 50 } });
  arrow.to.elementId = 'a';
  assert.deepEqual(model.arrowEndpoints(arrow, [a]), { from: { x: 100, y: 50 }, to: { x: 0, y: 50 } });
});

test('bounds include negative positions and free arrow endpoints, ignoring arrow box geometry', () => {
  const note = model.createItem('note', { id: 'a', x: -100, y: -50, width: 100, height: 100 });
  const arrow = model.createItem('arrow', { x: 999, y: 999, width: 9000, height: 9000, from: { x: 0, y: 0, elementId: 'a' }, to: { x: 200, y: 250 } });
  assert.deepEqual(model.getBounds([]), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(model.getBounds([note, arrow]), { x: -100, y: -50, width: 300, height: 300 });
});

test('limits use UTF-8 bytes and reject excess elements or oversized embedded files', () => {
  assert.throws(() => model.parse('あ'.repeat(Math.floor(model.LIMITS.fileBytes / 3) + 1)), /40MB/);
  const item = model.createItem('note');
  assert.throws(() => parseObject(board(...Array(model.LIMITS.elements + 1).fill(item))), /要素数/);
  assert.throws(() => model.createItem('text', { text: 'x'.repeat(model.LIMITS.text + 1) }));
});

test('text-bearing rectangle, ellipse and diamond round trip with independent fill and ink', () => {
  const shapes = ['rect', 'ellipse', 'diamond'].map(type => model.createItem(type, { text: '図形の中に\n日本語テキスト', textColor: '#ffffff' }));
  assert.deepEqual(model.parse(model.serialize(board(...shapes))), board(...shapes));
  assert.deepEqual(shapes.map(item => [item.type, item.width, item.height, item.color, item.fontSize]), [
    ['rect', 220, 130, '#daeafd', 20], ['ellipse', 220, 130, '#d7f1e3', 20], ['diamond', 240, 160, '#eee0ff', 20]
  ]);
  const importedWithoutInk = { ...shapes[0] };
  delete importedWithoutInk.textColor;
  assert.equal(parseObject(board(importedWithoutInk)).elements[0].textColor, '#24334a');
  assert.throws(() => parseObject(board({ ...shapes[0], textColor: 'red' })));
  assert.throws(() => parseObject(board({ ...shapes[1], text: 42 })));
  assert.equal(model.createItem('note').fontSize, 20);
  assert.equal(model.createItem('text').fontSize, 24);
});

test('ellipse and diamond bound arrows meet the actual shape boundary from every direction', () => {
  for (const type of ['rect', 'ellipse', 'diamond']) {
    const shape = model.createItem(type, { id: 'shape', x: -120, y: -80, width: 240, height: 160 });
    for (const [x, y] of [[500, 500], [-500, 300], [-500, -300], [500, -300], [0, 300], [500, 0]]) {
      const arrow = model.createItem('arrow', { from: { x: 0, y: 0, elementId: 'shape' }, to: { x, y } });
      const endpoint = model.arrowEndpoints(arrow, [shape]).from;
      const nx = Math.abs(endpoint.x) / 120;
      const ny = Math.abs(endpoint.y) / 80;
      const boundary = type === 'ellipse' ? nx * nx + ny * ny : type === 'diamond' ? nx + ny : Math.max(nx, ny);
      assert.ok(Math.abs(boundary - 1) < 1e-12, type + ' endpoint on boundary');
      assert.ok(Math.abs(endpoint.x * y - endpoint.y * x) < 1e-9, type + ' endpoint on ray to target');
    }
  }
});

test('connections between curved shapes stay bound when shapes are moved and resized', () => {
  const ellipse = model.createItem('ellipse', { id: 'ellipse', x: 0, y: 0, width: 200, height: 100 });
  const diamond = model.createItem('diamond', { id: 'diamond', x: 400, y: 0, width: 200, height: 100 });
  const arrow = model.createItem('arrow', { from: { x: 0, y: 0, elementId: ellipse.id }, to: { x: 0, y: 0, elementId: diamond.id } });
  const elements = model.parse(model.serialize(board(ellipse, diamond, arrow))).elements;
  assert.deepEqual(model.arrowEndpoints(elements[2], elements), { from: { x: 200, y: 50 }, to: { x: 400, y: 50 } });
  elements[1].x = 0; elements[1].y = 400; elements[1].height = 200;
  assert.deepEqual(model.arrowEndpoints(elements[2], elements), { from: { x: 100, y: 100 }, to: { x: 100, y: 400 } });
  elements[1].x = 0; elements[1].y = 0; elements[1].height = 100;
  assert.deepEqual(model.arrowEndpoints(elements[2], elements), { from: { x: 200, y: 50 }, to: { x: 0, y: 50 } });
});

test('version-1 arrows missing new fields receive compatible label, line and head defaults', () => {
  const legacy = model.createItem('arrow');
  delete legacy.label; delete legacy.lineStyle; delete legacy.head;
  const parsed = parseObject(board(legacy));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.elements[0], { ...legacy, label: '', lineStyle: 'solid', head: 'end' });
  assert.equal(model.arrowLabelLayout(legacy, [legacy]), null);
  assert.equal(model.arrowLabelLayout(model.createItem('arrow', { label: ' \n  ' }), []), null);
  assert.deepEqual(model.getBounds([legacy]), { x: 0, y: 0, width: 160, height: 0 });
});

test('labeled arrows round trip all style combinations and preserve literal text safely as data', () => {
  const arrows = [];
  for (const lineStyle of ['solid', 'dashed']) {
    for (const head of ['end', 'both', 'none']) {
      arrows.push(model.createItem('arrow', { label: '条件 🧠\n<script>alert("x")</script>&', lineStyle, head }));
    }
  }
  const original = board(...arrows);
  const imported = model.parse(model.serialize(original));
  assert.deepEqual(imported, original);
  assert.equal(model.arrowLabelLayout(imported.elements[0], []).lines.join('').includes('<script>'), true);
  const exactLimit = model.createItem('arrow', { label: '🧠'.repeat(200) });
  assert.equal(parseObject(board(exactLimit)).elements[0].label, exactLimit.label);
});

test('invalid arrow styles or oversized/non-string labels reject import without mutating a document', () => {
  const arrow = model.createItem('arrow', { label: '元のラベル' });
  const original = board(arrow);
  const before = model.serialize(original);
  for (const invalid of [{ label: 12 }, { label: null }, { label: {} }, { label: '🧠'.repeat(201) }, { lineStyle: 'dotted' }, { lineStyle: null }, { head: 'start' }, { head: true }]) {
    assert.throws(() => parseObject(board({ ...arrow, ...invalid })));
  }
  assert.equal(model.serialize(original), before);
});

test('Unicode labels wrap without splitting surrogate pairs and reserve predictable padded bounds', () => {
  const arrow = model.createItem('arrow', { from: { x: 0, y: 0 }, to: { x: 0, y: 200 }, label: '日本語ラベルと絵文字🧠です' });
  const layout = model.arrowLabelLayout(arrow, [arrow]);
  assert.deepEqual(layout.lines, ['日本語ラベルと絵文字🧠', 'です']);
  assert.equal(layout.width, 192);
  assert.equal(layout.height, 56);
  assert.equal(layout.x, -96);
  assert.equal(layout.y, 72);
  assert.equal(layout.lineHeight, 22);
  assert.deepEqual(model.getBounds([arrow]), { x: -96, y: 0, width: 192, height: 200 });
  const mixed = model.createItem('arrow', { label: 'ABC日本語\r\n\n🧠XYZ' });
  const mixedLayout = model.arrowLabelLayout(mixed, []);
  assert.deepEqual(mixedLayout.lines, ['ABC日本語', '', '🧠XYZ']);
  assert.equal(mixedLayout.width, 94);
  assert.equal(mixedLayout.height, 78);
});

test('label bounds follow diagonal bound arrows after movement and remain finite at coordinate limits', () => {
  const shape = model.createItem('ellipse', { id: 'shape', x: -50, y: -50, width: 100, height: 100 });
  const arrow = model.createItem('arrow', { from: { x: 0, y: 0, elementId: 'shape' }, to: { x: 30, y: 30 }, label: '斜めの接続ラベル' });
  const elements = [shape, arrow];
  const check = () => {
    const endpoints = model.arrowEndpoints(arrow, elements);
    const label = model.arrowLabelLayout(arrow, elements);
    assert.equal(label.x + label.width / 2, (endpoints.from.x + endpoints.to.x) / 2);
    assert.equal(label.y + label.height / 2, (endpoints.from.y + endpoints.to.y) / 2);
    const bounds = model.getBounds(elements);
    assert.ok(bounds.x <= label.x && bounds.y <= label.y);
    assert.ok(bounds.x + bounds.width >= label.x + label.width);
    assert.ok(bounds.y + bounds.height >= label.y + label.height);
    return label;
  };
  const first = check();
  shape.x = 200; shape.y = -500;
  assert.notEqual(check().x, first.x);
  arrow.from = { x: model.LIMITS.coordinate, y: -model.LIMITS.coordinate };
  arrow.to = { x: model.LIMITS.coordinate, y: -model.LIMITS.coordinate };
  const atLimit = model.arrowLabelLayout(arrow, []);
  assert.ok(['x', 'y', 'width', 'height'].every(key => Number.isFinite(atLimit[key])));
});
