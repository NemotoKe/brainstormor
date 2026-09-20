'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/diagram-model.js');
const T = require('../src/mermaid-templates.js');

function snapshot(model) {
  const indices = new Map(model.nodes.map((node, index) => [node.id, index]));
  return {
    kind: model.kind, direction: model.direction,
    nodes: model.nodes.map(node => ({ text: node.text, shape: node.shape, color: node.element?.color, textColor: node.element?.textColor, fontSize: node.element?.fontSize })),
    links: model.links.map(link => ({ from: indices.get(link.from), to: indices.get(link.to), text: link.text, kind: link.kind, head: link.element?.head, color: link.element?.color, strokeWidth: link.element?.strokeWidth }))
  };
}
function freeze(object) {
  if (object && typeof object === 'object') { Object.freeze(object); Object.values(object).forEach(freeze); }
  return object;
}

test('renaming a sequence participant preserves identities, message destinations and message order', () => {
  const model = D.parse(T.getTemplate('sequence').source);
  const originalLinks = structuredClone(model.links);
  model.nodes[1].text = 'モバイルアプリ\n日本語の名前';
  const serialized = D.serialize(model);
  const result = D.parse(serialized);
  assert.equal(result.kind, 'sequence');
  assert.deepEqual(result.nodes, model.nodes);
  assert.deepEqual(result.links, originalLinks);
  assert.ok(serialized.includes('participant p2 as モバイルアプリ<br/>日本語の名前'));
});

test('adding and redirecting a conditional branch keeps all existing arrow and node styles', () => {
  const model = D.parse('flowchart RL\nA["受付"] -->|"開始"| B{"実行する？"}\nB -.->|"保留"| C(("待機"))\nC <-->|"確認"| A\nB ---|"なし"| D["別案"]\nstyle A fill:#aabbcc,color:#223344,font-size:27px\nstyle B fill:#ffeedd,color:#113355,font-size:19px\nlinkStyle 0 stroke:#123456,stroke-width:3px\nlinkStyle 1 stroke:#abcdef,stroke-width:4px\nlinkStyle 2 stroke:#987654,stroke-width:5px,stroke-dasharray:6 4\nlinkStyle 3 stroke:#112233,stroke-width:2px\n');
  assert.ok(model);
  const styles = model.links.map(link => ({ ...snapshot(model).links[model.links.indexOf(link)] }));
  model.nodes[1].text = '予算内で実行できる？';
  model.nodes.push({ id: 'new_result', text: '実行して振り返る', shape: 'rect' });
  model.links[0].to = 'new_result';
  model.links.push({ from: model.nodes[1].id, to: 'new_result', text: 'はい', kind: 'request' });
  const before = structuredClone(model);
  const result = D.parse(D.serialize(freeze(model)));
  assert.deepEqual(model, before, 'serialization must not mutate an active editor model');
  assert.equal(result.direction, 'RL');
  assert.deepEqual(result.nodes.map(node => [node.text, node.shape]), [['受付', 'rect'], ['予算内で実行できる？', 'diamond'], ['待機', 'ellipse'], ['別案', 'rect'], ['実行して振り返る', 'rect']]);
  assert.equal(result.nodes[0].element.color, '#aabbcc');
  assert.equal(result.nodes[0].element.textColor, '#223344');
  assert.equal(result.nodes[0].element.fontSize, 27);
  assert.equal(result.nodes[1].element.color, '#ffeedd');
  const resultingLinks = snapshot(result).links;
  for (let index = 0; index < styles.length; index++) {
    assert.deepEqual(resultingLinks[index], { ...styles[index], ...(index === 0 ? { to: 4 } : {}) });
  }
  assert.equal(resultingLinks[4].from, 1);
  assert.equal(resultingLinks[4].to, 4);
  assert.equal(resultingLinks[4].text, 'はい');
});

test('all six arrow head and line-style combinations survive harmless form edits', () => {
  const source = 'flowchart TD\nA["始点"]\nB["終点"]\nA -->|"片方向"| B\nA ---|"線"| B\nA <-->|"双方向"| B\nA -.->|"破線"| B\nA -.-|"破線の線"| B\nA <-->|"破線の双方向"| B\nlinkStyle 5 stroke:#ff0000,stroke-dasharray:6 4\n';
  const model = D.parse(source);
  model.nodes[0].text = '変更後の始点';
  assert.deepEqual(snapshot(D.parse(D.serialize(model))), snapshot(model));
  assert.deepEqual(model.links.map(link => [link.kind, link.element.head]), [['request', 'end'], ['request', 'none'], ['request', 'both'], ['reply', 'end'], ['reply', 'none'], ['reply', 'both']]);
});

test('connected nodes cannot be deleted until references are explicitly changed', () => {
  for (const kind of ['sequence', 'flowchart']) {
    const model = D.parse(T.getTemplate(kind).source);
    const original = structuredClone(model);
    assert.throws(() => D.removeNode(model, model.nodes[0].id), /接続/);
    assert.deepEqual(model, original);
    const spare = { id: 'unused', text: '未接続', ...(kind === 'flowchart' ? { shape: 'rect' } : {}) };
    model.nodes.push(spare);
    const removed = D.removeNode(model, spare.id);
    assert.deepEqual(removed.nodes, original.nodes);
    assert.deepEqual(removed.links, original.links);
    assert.equal(model.nodes.at(-1), spare, 'deletion returns a new model');
    assert.ok(D.parse(D.serialize(removed)));
  }
  assert.throws(() => D.removeNode({ kind: 'flowchart', nodes: [{ id: 'a' }], links: [] }, 'a'), /1個/);
  assert.throws(() => D.removeNode({ kind: 'sequence', nodes: [{ id: 'a' }, { id: 'b' }], links: [] }, 'a'), /2個/);
});

test('dangling endpoints are rejected instead of silently dropping connections during export', () => {
  for (const kind of ['sequence', 'flowchart']) {
    for (const endpoint of ['from', 'to']) {
      const model = D.parse(T.getTemplate(kind).source);
      model.links[0][endpoint] = 'deleted';
      assert.throws(() => D.serialize(model), /送信先|接続先/);
    }
  }
});

test('labels that look like markup remain text after a flowchart form edit', () => {
  const model = D.parse(T.getTemplate('flowchart').source);
  model.nodes[0].text = '日本語 "引用" <script> #35;\nA --> B & | [角括弧]';
  model.links[0].text = 'はい | "引用" #quot;\n条件が一致';
  const result = D.parse(D.serialize(model));
  assert.ok(result);
  assert.equal(result.nodes[0].text, model.nodes[0].text);
  assert.equal(result.links[0].text, model.links[0].text);
  assert.equal(result.nodes.length, model.nodes.length);
  assert.equal(result.links.length, model.links.length);
});

test('advanced source is kept in code editing rather than partially imported into the form', () => {
  for (const source of [
    'flowchart LR\nsubgraph group\nA-->B\nend',
    'flowchart LR\nA-->B\nclick A "https://example.com"',
    'flowchart LR\nA[(データベース)]-->B',
    'flowchart LR\nA o--o B',
    'sequenceDiagram\nparticipant A\nparticipant B\nloop 3回\nA->>B:繰り返す\nend',
    'sequenceDiagram\nparticipant A\nparticipant B\nNote over A,B:説明',
    T.getTemplate('class').source, T.getTemplate('er').source, T.getTemplate('state').source
  ]) assert.equal(D.parse(source), null, source);
});

test('visually lossy flowchart conversions do not enable the safe editing form', () => {
  for (const source of [
    'flowchart LR\nA(角丸) --> B[四角]',
    'flowchart LR\nA["項目"]\nstyle A fill:red',
    'flowchart LR\nA["項目"]\nstyle A stroke-width:8px',
    'flowchart LR\nA["<b>太字</b>"]',
    'flowchart LR\nA["`**太字**`"]',
    'flowchart LR\nA ----> B'
  ]) assert.equal(D.parse(source), null, source);
});

test('header-like text in a comment cannot change the direction of a diagram', () => {
  const model = D.parse('%% flowchart BT is only a comment\nflowchart LR\nA-->B');
  assert.ok(model === null || model.direction === 'LR');
});
