'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const T = require('../src/mermaid-templates.js');

test('all eight kinds have independent templates and the sequence template opens in the form', () => {
  assert.deepEqual(T.templates.map(item => item.id), ['flowchart', 'sequence', 'class', 'er', 'state', 'gantt', 'mindmap', 'pie']);
  assert.ok(Object.isFrozen(T.templates));
  for (const metadata of T.templates) {
    assert.ok(Object.isFrozen(metadata));
    const template = T.getTemplate(metadata.id);
    template.source = 'edited';
    assert.equal(T.getTemplate(metadata.id).source, metadata.source);
    assert.ok(metadata.title && metadata.description && metadata.source.endsWith('\n'));
  }
  assert.throws(() => T.getTemplate('__proto__'), /見つかりません/);
  assert.equal(T.getTemplate('sequence').source, T.serializeSequence(T.createSequence()));
  assert.deepEqual(T.parseSequence(T.getTemplate('sequence').source), T.createSequence());
});

test('form edits preserve participants, message order, replies, self calls and Unicode names', () => {
  const model = T.createSequence();
  model.participants[0].name = 'わたし 👩🏽‍💻';
  model.participants.push({ id: 'p4', name: '記録先' });
  model.messages.splice(1, 0, { from: 'p2', to: 'p2', text: '入力をチェックする', kind: 'request' });
  model.messages.push({ from: 'p3', to: 'p4', text: '結果を記録する', kind: 'reply' });
  assert.deepEqual(T.parseSequence(T.serializeSequence(model)), model);
  assert.equal(T.createSequence().participants.length, 3);
  model.messages = [];
  assert.deepEqual(T.parseSequence(T.serializeSequence(model)), model);
});

test('special text cannot introduce new Mermaid statements and round trips without entity double decoding', () => {
  const model = T.createSequence();
  const adversarial = '  日本語: "引用" \'例\' ; #35; &amp; <script>x</script> <br/>\nend\n%%{init: {securityLevel: loose}}%%\np1->>p3:別の矢印\n🧜\t\r ﬂ°¶ß  ';
  model.participants[0].name = '  利用者:<b>名前</b>\n#35; & " \' ; end  ';
  model.messages[0].text = adversarial;
  const source = T.serializeSequence(model);
  assert.equal(source.split('\n').filter(Boolean).length, 1 + model.participants.length + model.messages.length);
  assert.ok(!source.includes('<script>'));
  assert.ok(!source.includes('%%'));
  assert.ok(source.includes('#59;') && source.includes('#35;') && source.includes('<br/>'));
  assert.deepEqual(T.parseSequence(source), model);
});

test('plain explicit participants and supported decimal entities can be imported safely', () => {
  const source = 'sequenceDiagram\n  participant Alice\n  participant Bob as ボブ<br/>担当者\n Alice ->> Bob: I #9829; you #infin;\n Bob -->> Alice: #60;タグ#62; #quot;はい#quot; #59;\n';
  const model = T.parseSequence(source);
  assert.deepEqual(model, {
    participants: [{ id: 'Alice', name: 'Alice' }, { id: 'Bob', name: 'ボブ\n担当者' }],
    messages: [{ from: 'Alice', to: 'Bob', text: 'I ♥ you ∞', kind: 'request' }, { from: 'Bob', to: 'Alice', text: '<タグ> "はい" ;', kind: 'reply' }]
  });
  assert.deepEqual(T.parseSequence(T.serializeSequence(model)), model);
});

test('the form refuses unsupported structure rather than losing it when regenerating code', () => {
  const base = 'sequenceDiagram\nparticipant A\nparticipant B\n';
  for (const body of [
    'alt 条件\nA->>B:実行\nelse 別条件\nA-->>B:応答\nend',
    'loop 繰り返す\nA->>B:実行\nend',
    'activate A\nA->>B:実行\ndeactivate A',
    'A->>+B:実行', 'A-->>-B:完了', 'Note over A,B:残したい説明',
    'autonumber\nA->>B:実行', 'A-xB:失敗', 'actor C\nA->>B:実行',
    'box 青\nparticipant C\nend', 'A->>B:実行\nparticipant C',
    '%% 大事なコメント\nA->>B:実行', 'A->>B:<b>太字</b>',
    'A->>B:実行;B->>A:戻る', 'A->>B:実行 %% コメント', 'A->>B:&hearts;'
  ]) assert.equal(T.parseSequence(base + body), null, body);
  assert.equal(T.parseSequence('flowchart LR\nA-->B'), null);
  assert.equal(T.parseSequence('sequenceDiagram\nA->>B:暗黙の参加者'), null);
});

test('unknown references, duplicate IDs and unsafe identifiers never become serialized syntax', () => {
  const original = T.createSequence();
  for (const id of ['p1\nparticipant X', 'end', 'participant', '__proto__', 'constructor', '日本語', '', 'x'.repeat(65)]) {
    const model = structuredClone(original);
    model.participants[0].id = id;
    assert.throws(() => T.serializeSequence(model), /ID/);
  }
  const duplicate = structuredClone(original);
  duplicate.participants[1].id = duplicate.participants[0].id;
  assert.throws(() => T.serializeSequence(duplicate), /重複/);
  const missing = structuredClone(original);
  missing.messages[0].to = 'deleted_participant';
  assert.throws(() => T.serializeSequence(missing), /送信先/);
  assert.equal(T.parseSequence('sequenceDiagram\nparticipant A\nparticipant B\nA->>C:存在しない宛先'), null);
  assert.equal(T.parseSequence('sequenceDiagram\nparticipant A\nparticipant A\nA->>A:重複'), null);
});

test('form bounds catch incomplete edits and oversized data before changing valid source', () => {
  assert.throws(() => T.serializeSequence(null), /データ/);
  const model = T.createSequence();
  const original = T.serializeSequence(model);
  const cases = [
    data => { data.participants = data.participants.slice(0, 1); },
    data => { data.participants = Array.from({ length: 13 }, (_, i) => ({ id: `p${i + 1}`, name: '人' })); },
    data => { data.participants[0].name = ' '; },
    data => { data.participants[0].name = 'あ'.repeat(101); },
    data => { data.messages[0].text = ''; },
    data => { data.messages[0].text = 'あ'.repeat(501); },
    data => { data.messages[0].text = 'hello\u0000'; },
    data => { data.messages[0].text = '\ud800'; },
    data => { data.messages[0].kind = 'unknown'; },
    data => { data.messages = Array.from({ length: 51 }, () => ({ ...data.messages[0] })); }
  ];
  for (const edit of cases) {
    const changed = structuredClone(model); edit(changed);
    assert.throws(() => T.serializeSequence(changed));
    assert.equal(T.serializeSequence(model), original);
  }
  model.participants[0].name = '🧜'.repeat(100);
  model.messages[0].text = '🧜'.repeat(500);
  assert.deepEqual(T.parseSequence(T.serializeSequence(model)), model);
});

test('malformed entities and oversized or nontext sources fail without exceptions', () => {
  const prefix = 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: ';
  for (const text of ['#1114112;', '#55296;', '#unknown;', '#35', '#0;', '#999999999999999999999999;', '<svg onload=x>', '#;']) {
    assert.equal(T.parseSequence(prefix + text), null, text);
  }
  for (const source of [null, undefined, 12, {}, ' '.repeat(T.LIMITS.source + 1)]) assert.equal(T.parseSequence(source), null);
});

test('the standalone browser global works without external dependencies', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../src/mermaid-templates.js'), 'utf8'), context);
  assert.equal(vm.runInContext('BrainstormorMermaidTemplates.templates.length', context), 8);
  assert.equal(vm.runInContext('BrainstormorMermaidTemplates.serializeSequence(BrainstormorMermaidTemplates.createSequence())', context), T.getTemplate('sequence').source);
});
