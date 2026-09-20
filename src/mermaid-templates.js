(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BrainstormorMermaidTemplates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({ participants: 12, messages: 50, name: 100, text: 500, source: 200000 });
  const ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const RESERVED = new Set('sequenceDiagram participant actor as end loop alt else opt par and critical option break rect note over right left of activate deactivate create destroy box links link autonumber accTitle accDescr title __proto__ constructor prototype'.toLowerCase().split(' '));
  const ENTITIES = Object.freeze({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', num: '#', infin: '∞', hearts: '♥' });

  function validId(id) { return typeof id === 'string' && ID.test(id) && !RESERVED.has(id.toLowerCase()); }
  function validateText(text, limit, label) {
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${label}を入力してください。`);
    if (Array.from(text).length > limit) throw new Error(`${label}は${limit}文字以内にしてください。`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error(`${label}に使用できない制御文字があります。`);
    for (const character of text) {
      const code = character.codePointAt(0);
      if (code >= 0xd800 && code <= 0xdfff) throw new Error(`${label}に不正な文字があります。`);
    }
  }
  function validateSequence(model) {
    if (!model || !Array.isArray(model.participants) || !Array.isArray(model.messages)) throw new Error('シーケンス図のデータが正しくありません。');
    if (model.participants.length < 2 || model.participants.length > LIMITS.participants) throw new Error(`参加者は2〜${LIMITS.participants}人にしてください。`);
    if (model.messages.length > LIMITS.messages) throw new Error(`メッセージは${LIMITS.messages}件以内にしてください。`);
    const ids = new Set();
    model.participants.forEach((participant, index) => {
      if (!participant || !validId(participant.id)) throw new Error(`${index + 1}人目の参加者IDが正しくありません。`);
      if (ids.has(participant.id)) throw new Error('参加者のIDが重複しています。');
      ids.add(participant.id);
      validateText(participant.name, LIMITS.name, `${index + 1}人目の名前`);
    });
    model.messages.forEach((message, index) => {
      if (!message || !ids.has(message.from) || !ids.has(message.to)) throw new Error(`${index + 1}件目の送信元・送信先を選んでください。`);
      if (!['request', 'reply'].includes(message.kind)) throw new Error(`${index + 1}件目のメッセージ種別が正しくありません。`);
      validateText(message.text, LIMITS.text, `${index + 1}件目のメッセージ`);
    });
    return true;
  }

  // Mermaid documents numeric entities (#35;, #59; etc.) and <br/> for line breaks.
  // https://mermaid.js.org/syntax/sequenceDiagram.html#entity-codes-to-escape-characters
  // Encode punctuation, boundary spaces and the reserved word "end" before it can be parsed as syntax.
  function encodeText(text) {
    const characters = Array.from(text);
    let encoded = characters.map((character, index) => {
      if (character === '\n') return '<br/>';
      if (/^[A-Za-z0-9_]$/.test(character)) return character;
      if (character === ' ' && index > 0 && index < characters.length - 1) return character;
      const code = character.codePointAt(0);
      return code > 127 && ![0x2028, 0x2029, 0xfb02, 0xb0, 0xb6, 0xdf].includes(code) ? character : `#${code};`;
    }).join('');
    return encoded.replace(/\bend\b/gi, word => `#${word.charCodeAt(0)};${word.slice(1)}`);
  }
  function decodeText(text) {
    let result = '';
    for (let index = 0; index < text.length;) {
      const remainder = text.slice(index);
      const lineBreak = /^<br\s*\/?\s*>/i.exec(remainder);
      if (lineBreak) { result += '\n'; index += lineBreak[0].length; continue; }
      const entity = /^#([0-9]+|[a-z]+);/i.exec(remainder);
      if (entity) {
        if (/^\d+$/.test(entity[1])) {
          const code = Number(entity[1]);
          if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
          result += String.fromCodePoint(code);
        } else {
          if (!Object.prototype.hasOwnProperty.call(ENTITIES, entity[1])) return null;
          result += ENTITIES[entity[1]];
        }
        index += entity[0].length; continue;
      }
      // Rich HTML, comments and statement separators cannot be faithfully represented by this form.
      if (/[#;&<>%\u2028\u2029\ufb02\u00b0\u00b6\u00df]/.test(text[index])) return null;
      result += text[index++];
    }
    return result;
  }
  function createSequence() {
    return {
      participants: [{ id: 'p1', name: '利用者' }, { id: 'p2', name: 'アプリ' }, { id: 'p3', name: 'サーバー' }],
      messages: [
        { from: 'p1', to: 'p2', text: '情報を入力する', kind: 'request' },
        { from: 'p2', to: 'p3', text: '保存を依頼する', kind: 'request' },
        { from: 'p3', to: 'p2', text: '保存結果を返す', kind: 'reply' },
        { from: 'p2', to: 'p1', text: '完了を表示する', kind: 'reply' }
      ]
    };
  }
  function serializeSequence(model) {
    validateSequence(model);
    return [
      'sequenceDiagram',
      ...model.participants.map(participant => `    participant ${participant.id} as ${encodeText(participant.name)}`),
      ...model.messages.map(message => `    ${message.from}${message.kind === 'reply' ? '-->>' : '->>'}${message.to}: ${encodeText(message.text)}`)
    ].join('\n') + '\n';
  }
  function parseSequence(source) {
    // Return null instead of partially importing a diagram: a GUI edit must never discard unsupported syntax.
    if (typeof source !== 'string' || source.length > LIMITS.source) return null;
    const lines = source.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.shift() !== 'sequenceDiagram') return null;
    const model = { participants: [], messages: [] };
    let sawMessage = false;
    for (const line of lines) {
      const participant = /^participant\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+(.+))?$/.exec(line);
      if (participant) {
        if (sawMessage) return null;
        const name = participant[2] === undefined ? participant[1] : decodeText(participant[2]);
        if (name === null) return null;
        model.participants.push({ id: participant[1], name });
        continue;
      }
      const message = /^([A-Za-z_][A-Za-z0-9_]*)\s*(-->>|->>)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (!message) return null;
      const text = decodeText(message[4]);
      if (text === null) return null;
      model.messages.push({ from: message[1], to: message[3], text, kind: message[2] === '-->>' ? 'reply' : 'request' });
      sawMessage = true;
    }
    try { validateSequence(model); return model; } catch (_) { return null; }
  }

  const templates = Object.freeze([
    {
      id: 'flowchart', kind: 'flowchart', title: 'フローチャート', description: '手順や条件分岐をつなげる',
      source: 'flowchart TD\n    A["アイデアを出す"] --> B{"試す価値がある？"}\n    B -->|"はい"| C["小さく試す"]\n    B -->|"いいえ"| A\n    C --> D["結果を振り返る"]\n'
    },
    { id: 'sequence', kind: 'sequence', title: 'シーケンス図', description: '参加者とメッセージの順番を描く', source: serializeSequence(createSequence()) },
    {
      id: 'class', kind: 'class', title: 'クラス図', description: 'データの構造と役割を整理する',
      source: 'classDiagram\n    class User {\n        +String name\n        +createNote() Note\n    }\n    class Note {\n        +String title\n        +String body\n        +save()\n    }\n    User "1" --> "0..*" Note : 作成する\n'
    },
    {
      id: 'er', kind: 'er', title: 'ER図', description: 'テーブルの項目と関係を設計する',
      source: 'erDiagram\n    USER ||--o{ NOTE : creates\n    USER {\n        int id PK\n        string name\n    }\n    NOTE {\n        int id PK\n        int user_id FK\n        string title\n    }\n'
    },
    {
      id: 'state', kind: 'state', title: '状態遷移図', description: '状態の変化ときっかけを並べる',
      source: 'stateDiagram-v2\n    state "下書き" as Draft\n    state "確認中" as Review\n    state "完了" as Done\n    [*] --> Draft\n    Draft --> Review: 確認を依頼\n    Review --> Draft: 修正する\n    Review --> Done: 承認する\n    Done --> [*]\n'
    },
    {
      id: 'gantt', kind: 'gantt', title: 'ガントチャート', description: '作業の期間と順番を計画する',
      source: 'gantt\n    title 小さく試す計画\n    dateFormat YYYY-MM-DD\n    section 準備\n    アイデアを整理 :a1, 2026-01-05, 2d\n    section 実行\n    試作品を作る :a2, after a1, 5d\n    振り返る :a3, after a2, 1d\n'
    },
    {
      id: 'mindmap', kind: 'mindmap', title: 'マインドマップ', description: 'テーマから連想を広げる',
      source: 'mindmap\n  root((新しいアイデア))\n    だれのため\n      利用する人\n      困っていること\n    なにをする\n      最初に試すこと\n      あとで試すこと\n    どう進める\n      必要なもの\n      次の一歩\n'
    },
    {
      id: 'pie', kind: 'pie', title: '円グラフ', description: '数値の割合を見比べる',
      source: 'pie title アイデアの内訳\n    "すぐ試す" : 40\n    "調べてから試す" : 35\n    "あとで考える" : 25\n'
    }
  ].map(template => Object.freeze(template)));
  function getTemplate(id) {
    const template = templates.find(item => item.id === id);
    if (!template) throw new Error('このMermaidテンプレートは見つかりません。');
    return { ...template };
  }
  return Object.freeze({ LIMITS, templates, getTemplate, createSequence, validateSequence, serializeSequence, parseSequence });
});
