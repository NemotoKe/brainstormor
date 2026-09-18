'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = require('../src/model.js');
const Mermaid = require('../src/mermaid.js');

function nodes(doc) { return doc.elements.filter(item => item.type !== 'arrow'); }
function arrows(doc) { return doc.elements.filter(item => item.type === 'arrow'); }
function overlap(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
function board(...elements) { return { ...M.createDocument('Mermaidテスト'), elements }; }
function edge(from, to, options = {}) { return M.createItem('arrow', { from: { x: 0, y: 0, elementId: from.id }, to: { x: 0, y: 0, elementId: to.id }, ...options }); }

test('imports fenced multiline flowcharts, Unicode IDs, chained edges and quoted labels', () => {
  const { document: doc, warnings } = Mermaid.importFlowchart('```mermaid\n%% コメント\nflowchart LR; 始点["企画を考える"] -->|"次へ"| B("検討") --> C(("完了"))\nB -- いいえ --> 判定{"条件に合う？"}\n判定 -. 再試行 .-> 始点\n```');
  assert.deepEqual(nodes(doc).map(item => [item.type, item.text]), [['rect', '企画を考える'], ['rect', '検討'], ['ellipse', '完了'], ['diamond', '条件に合う？']]);
  assert.deepEqual(arrows(doc).map(item => [item.label, item.lineStyle, item.head]), [['次へ', 'solid', 'end'], ['', 'solid', 'end'], ['いいえ', 'solid', 'end'], ['再試行', 'dashed', 'end']]);
  const validIds = new Set(nodes(doc).map(item => item.id));
  for (const arrow of arrows(doc)) { assert.ok(validIds.has(arrow.from.elementId)); assert.ok(validIds.has(arrow.to.elementId)); }
  assert.deepEqual(M.parse(M.serialize(doc)), doc);
  assert.ok(warnings.some(message => message.includes('角丸')));
});

test('all supported directions arrange a simple graph in the declared direction', () => {
  for (const direction of ['LR', 'RL', 'TD', 'TB', 'BT']) {
    const { document: doc } = Mermaid.importFlowchart(`graph ${direction}\nA --> B --> C`);
    const [a, b, c] = nodes(doc);
    if (direction === 'LR') assert.ok(a.x < b.x && b.x < c.x);
    if (direction === 'RL') assert.ok(a.x > b.x && b.x > c.x);
    if (direction === 'TD' || direction === 'TB') assert.ok(a.y < b.y && b.y < c.y);
    if (direction === 'BT') assert.ok(a.y > b.y && b.y > c.y);
  }
});

test('cycles, self loops, duplicate links and disconnected nodes terminate with visible nonoverlapping boxes', () => {
  const source = 'flowchart LR\nA --> B --> C --> A\nC --> D\nD --> D\nA --> B\n孤立\nX --> Y\nZ';
  const first = Mermaid.importFlowchart(source).document, second = Mermaid.importFlowchart(source).document;
  const boxes = nodes(first);
  assert.equal(boxes.length, 8); assert.equal(arrows(first).length, 7);
  assert.deepEqual(boxes.map(({ x, y, width, height }) => [x, y, width, height]), nodes(second).map(({ x, y, width, height }) => [x, y, width, height]));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i], boxes[j]));
});

test('last node declaration wins without breaking existing edges or prototype-like IDs', () => {
  const doc = Mermaid.importFlowchart('flowchart LR\n__proto__ --> constructor\n__proto__{"新しい名前"}\nconstructor["最後"]\n__proto__ --> constructor').document;
  assert.deepEqual(nodes(doc).map(item => [item.type, item.text]), [['diamond', '新しい名前'], ['rect', '最後']]);
  assert.equal(arrows(doc)[0].from.elementId, nodes(doc)[0].id);
  assert.equal(arrows(doc)[1].to.elementId, nodes(doc)[1].id);
  assert.equal({}.polluted, undefined);
});

test('supports all head and line combinations with edge labels and preserves exportable colors and fonts', () => {
  const a = M.createItem('rect', { id: 'unsafe id ] --> bad', text: '始点', color: '#aabbcc', textColor: '#1234', fontSize: 31 });
  const b = M.createItem('diamond', { text: '判断', color: '#fbdde9' });
  const links = [];
  for (const head of ['end', 'both', 'none']) for (const lineStyle of ['solid', 'dashed']) links.push(edge(a, b, { head, lineStyle, label: `${head}/${lineStyle} はい`, color: '#be454c', strokeWidth: 4.5 }));
  const original = freeze(board(a, b, ...links));
  const { source, warnings } = Mermaid.exportFlowchart(original, 'TB');
  assert.ok(source.startsWith('flowchart TB\n'));
  assert.ok(!source.includes(a.id));
  assert.ok(warnings.some(message => message.includes('位置')));
  const imported = Mermaid.importFlowchart(source).document;
  assert.deepEqual(arrows(imported).map(({ head, lineStyle, label, color, strokeWidth }) => ({ head, lineStyle, label, color, strokeWidth })), links.map(({ head, lineStyle, label, color, strokeWidth }) => ({ head, lineStyle, label, color, strokeWidth })));
  assert.deepEqual(nodes(imported).map(({ type, text, color, textColor, fontSize }) => ({ type, text, color, textColor, fontSize })), [a, b].map(({ type, text, color, textColor, fontSize }) => ({ type, text, color, textColor, fontSize })));
  assert.equal(original.elements[0], a);
});

test('numeric encoding preserves quotes, brackets, newlines, literal entities and script-like text exactly', () => {
  const text = ' 日本語 "quoted" [a] {b} (c) | ; & #34; &quot; \\ `code`\n<script>alert("x")</script><br/>\r終わり ';
  const a = M.createItem('ellipse', { text }), b = M.createItem('rect', { text: 'B' });
  const label = '"はい" | [条件]; #35; &amp;\n次へ <br/>';
  const exported = Mermaid.exportFlowchart(board(a, b, edge(a, b, { label })));
  assert.ok(exported.source.includes('#34;')); assert.ok(exported.source.includes('#91;')); assert.ok(!exported.source.includes('<script>'));
  const result = Mermaid.importFlowchart(exported.source).document;
  assert.equal(nodes(result)[0].text, text); assert.equal(arrows(result)[0].label, label);
});

test('imports decimal and common named entities, HTML breaks, and multiline quoted labels', () => {
  const { document: doc, warnings } = Mermaid.importFlowchart('flowchart TD\nA["#quot;#9829; &amp; &#x41; #35;34;<br/>2行目"]\nB["複数\n行のラベル"]\nA -->|#quot;| B\nC["<b>装飾</b>"]');
  assert.equal(nodes(doc)[0].text, '"♥ & A #34;\n2行目');
  assert.equal(nodes(doc)[1].text, '複数\n行のラベル');
  assert.equal(arrows(doc)[0].label, '"');
  assert.ok(warnings.some(message => message.includes('HTML装飾')));
});

test('node classes, inline classes, styles and indexed/default link styles apply after definitions', () => {
  const { document: doc, warnings } = Mermaid.importFlowchart(`flowchart LR
    A:::green --> B --> C
    classDef default fill:#ddd,color:#111
    classDef green fill:#d7f1e3,color:#137b6b,font-size:36px,stroke:#123
    class B green
    style A fill:#abc,color:#fff
    linkStyle default stroke:#be454c,stroke-width:4px
    linkStyle 1 stroke:#4664d3,stroke-dasharray:6 4`);
  assert.deepEqual(nodes(doc).map(item => [item.color, item.textColor]), [['#abc', '#fff'], ['#d7f1e3', '#137b6b'], ['#ddd', '#111']]);
  assert.equal(nodes(doc)[0].fontSize, 36); assert.equal(nodes(doc)[1].fontSize, 36);
  assert.deepEqual(arrows(doc).map(item => [item.color, item.strokeWidth, item.lineStyle]), [['#be454c', 4, 'solid'], ['#4664d3', 4, 'dashed']]);
  assert.ok(warnings.some(message => message.includes('stroke')));
});

test('export explicitly reports images, omitted free/image-bound arrows and simplified text/notes', () => {
  const note = M.createItem('note', { text: '付箋' }), text = M.createItem('text', { text: '文字', color: '#4664d3' }), image = M.createItem('image');
  const { source, warnings } = Mermaid.exportFlowchart(board(note, text, image, edge(note, text), edge(note, image), M.createItem('arrow')));
  assert.ok(warnings.some(message => message.includes('画像1個')));
  assert.ok(warnings.some(message => message.includes('付箋・テキスト2個')));
  assert.ok(warnings.some(message => message.includes('矢印2本')));
  const result = Mermaid.importFlowchart(source).document;
  assert.deepEqual(nodes(result).map(item => item.type), ['rect', 'rect']);
  assert.equal(nodes(result)[1].textColor, '#4664d3'); assert.equal(arrows(result).length, 1);
});

test('unsupported semantics and malformed syntax fail with Japanese line diagnostics and no partial document', () => {
  const invalid = [
    ['sequenceDiagram\nA->>B: message', 1], ['flowchart XX\nA', 1],
    ['flowchart LR\nA --> B\nsubgraph group\nC\nend', 3],
    ['flowchart LR\nA & B --> C', 2], ['flowchart LR\nA ==> B', 2],
    ['flowchart LR\nA ---oB', 2], ['flowchart LR\nA ---xB', 2],
    ['flowchart LR\nA --> B\nclick A "https://example.com"', 3],
    ['flowchart LR\nA@{ shape: cylinder }', 2], ['flowchart LR\nA[(database)]', 2],
    ['flowchart LR\nA[[subroutine]]', 2], ['flowchart LR\nA{{hexagon}}', 2],
    ['flowchart LR\nA["unclosed]', 2], ['flowchart LR\nA -->', 2],
    ['flowchart LR\nA["#unknownEntity;"]', 2], ['flowchart LR\nA["#1114112;"]', 2],
    ['flowchart LR\nA\nclass A missing', 3], ['flowchart LR\nA\nstyle missing fill:#fff', 3],
    ['flowchart LR\nA --> B\nlinkStyle 8 stroke:#fff', 3], ['flowchart LR\n%%{init: {}}%%\nA', 2],
    ['```mermaid\nflowchart LR\nA --> B\nsubgraph bad\n```', 4]
  ];
  for (const [source, line] of invalid) assert.throws(() => Mermaid.importFlowchart(source), error => error instanceof Error && error.message.startsWith(`${line}行目:`), source);
});

test('comments do not eat quoted content and statement separators do not split encoded labels', () => {
  const doc = Mermaid.importFlowchart('flowchart LR; A["%% not a comment; #quot;"] -->|#quot;| B; %% real comment\nB --> C["C; next"]\nD --- other').document;
  assert.equal(nodes(doc)[0].text, '%% not a comment; "');
  assert.equal(arrows(doc)[0].label, '"'); assert.equal(nodes(doc).length, 5);
  assert.equal(arrows(doc)[2].head, 'none');
});

test('limits fail early and invalid export directions or boards fail clearly', () => {
  assert.throws(() => Mermaid.importFlowchart('flowchart LR\nA["' + 'あ'.repeat(350000) + '"]'), /1行目:.*1MB/);
  assert.throws(() => Mermaid.importFlowchart('flowchart LR\n' + Array.from({ length: 5001 }, (_, index) => `N${index}`).join('\n')), /5000個/);
  assert.throws(() => Mermaid.importFlowchart('flowchart LR\nA -->|"' + '長'.repeat(201) + '"| B'), /2行目:.*200文字/);
  assert.throws(() => Mermaid.exportFlowchart(board(M.createItem('rect')), 'XX'), /向き/);
  assert.throws(() => Mermaid.exportFlowchart(board(M.createItem('image'))), /書き出せる/);
});

test('browser global works offline without a DOM or CommonJS', () => {
  const context = vm.createContext({ TextEncoder, atob });
  vm.runInContext(fs.readFileSync(require.resolve('../src/model.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../src/mermaid.js'), 'utf8'), context);
  const result = context.BrainstormorMermaid.importFlowchart('flowchart LR\nA --> B');
  assert.equal(result.document.elements.length, 3);
  assert.ok(context.BrainstormorMermaid.exportFlowchart(result.document).source.startsWith('flowchart LR'));
});
