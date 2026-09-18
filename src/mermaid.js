(function (root, factory) {
  'use strict';
  const commonJS = typeof module === 'object' && module.exports;
  const api = factory(commonJS ? require('./model.js') : root.BrainstormorModel);
  if (commonJS) module.exports = api;
  if (root) root.BrainstormorMermaid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  // This is an offline converter for the documented basic flowchart subset, not a Mermaid renderer.
  // Syntax reference: https://mermaid.js.org/syntax/flowchart.html
  const MAX_SOURCE_BYTES = 1024 * 1024;
  const DIRECTIONS = new Set(['LR', 'RL', 'TD', 'TB', 'BT']);
  const NODE_TYPES = new Set(['rect', 'ellipse', 'diamond', 'note', 'text']);
  const ID = /^[\p{L}\p{N}_]+/u;
  const COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
  const ENTITIES = Object.freeze({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', num: '#', lpar: '(', rpar: ')', lbrack: '[', rbrack: ']', vert: '|', hearts: '♥', copy: '©', reg: '®', trade: '™', hellip: '…', ndash: '–', mdash: '—' });
  function fail(line, message) { throw new Error(`${line}行目: ${message}`); }
  function bytes(text) { return new TextEncoder().encode(text).length; }
  function center(item) { return { x: item.x + item.width / 2, y: item.y + item.height / 2 }; }
  function warning(warnings, line, message) { warnings.push(`${line}行目: ${message}`); }

  function statements(source) {
    if (typeof source !== 'string') fail(1, 'Mermaidのコードをテキストで入力してください。');
    if (bytes(source) > MAX_SOURCE_BYTES) fail(1, 'Mermaidのコードは1MB以内にしてください。');
    const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const first = lines.findIndex(line => line.trim());
    if (first >= 0 && lines[first].trim().startsWith('```')) {
      if (!/^```(?:mermaid)?\s*$/i.test(lines[first].trim())) fail(first + 1, 'mermaidのコードブロックを選んでください。');
      let last = lines.length - 1;
      while (last > first && !lines[last].trim()) last--;
      if (last === first || lines[last].trim() !== '```') fail(first + 1, 'コードブロックを閉じる ``` がありません。');
      lines[first] = ''; lines[last] = '';
    }
    const text = lines.join('\n'), result = [], stack = [];
    let buffer = '', line = 1, start = 1, quoted = false, pipe = false;
    const push = () => { if (buffer.trim()) result.push({ text: buffer.trim(), line: start }); buffer = ''; };
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      if (!buffer.trim() && !/\s/.test(character)) start = line;
      if (quoted) {
        buffer += character;
        if (character === '\\' && ['"', '\\'].includes(text[i + 1])) { buffer += text[++i]; continue; }
        if (character === '"') quoted = false;
        if (character === '\n') line++;
        continue;
      }
      if (character === '"') { quoted = true; buffer += character; continue; }
      if (!stack.length && !pipe && character === '%' && text[i + 1] === '%') {
        if (text[i + 2] === '{') fail(line, '設定ディレクティブは未対応です。%%{ ... }%% を取り除いてください。');
        while (i < text.length && text[i] !== '\n') i++;
        if (i < text.length) { push(); line++; }
        continue;
      }
      if (!stack.length && character === '|') { pipe = !pipe; buffer += character; continue; }
      if (!pipe && '[({'.includes(character)) stack.push(character);
      if (!pipe && '])}'.includes(character)) {
        const opening = stack.pop();
        if (!opening || '[({'.indexOf(opening) !== '])}'.indexOf(character)) fail(line, '図形の括弧の組み合わせを確認してください。');
      }
      // Mermaid entity codes contain semicolons that are not statement separators.
      if (!stack.length && !pipe && (character === '#' || character === '&')) {
        const entity = /^(?:&#(?:x[\da-f]+|\d+)|#[\da-z]+|&[a-z][\da-z]*);/i.exec(text.slice(i));
        if (entity) { buffer += entity[0]; i += entity[0].length - 1; continue; }
      }
      if (!stack.length && !pipe && (character === ';' || character === '\n')) push();
      else buffer += character;
      if (character === '\n') line++;
    }
    if (quoted || stack.length || pipe) fail(start, 'ラベルの引用符・括弧・区切り記号を閉じてください。');
    push(); return result;
  }

  function decodeLabel(raw, line, warnings) {
    let text = raw.replace(/<br\s*\/?\s*>/gi, '\n');
    if (/<\/?[a-z][^>]*>/i.test(text)) warning(warnings, line, 'HTML装飾は適用せず、文字として読み込みます。');
    if (/^`[\s\S]*`$/.test(text)) warning(warnings, line, 'Markdown装飾は適用せず、記号を含む文字として読み込みます。');
    if (/\bfa[brsldk]?:fa-/i.test(text)) warning(warnings, line, 'アイコン指定は文字として読み込みます。');
    text = text.replace(/(?:&#(?:x[\da-f]+|\d+)|#[\da-z]+|&[a-z][\da-z]*);/gi, entity => {
      const key = entity.replace(/^&?#|^&/, '').slice(0, -1);
      if (/^\d+$/.test(key) || (/^&#x/i.test(entity) && /^x[\da-f]+$/i.test(key))) {
        const value = /^x/i.test(key) ? parseInt(key.slice(1), 16) : Number(key);
        if (!Number.isSafeInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) fail(line, '文字参照の番号が範囲外です。');
        return String.fromCodePoint(value);
      }
      if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
      fail(line, `文字参照「${entity}」は未対応です。#数字; の形式にしてください。`);
    });
    if (text.length > M.LIMITS.text) fail(line, '図形のテキストが長すぎます。');
    return text;
  }
  function readQuoted(text, position, line) {
    let value = '', i = position + 1;
    for (; i < text.length; i++) {
      if (text[i] === '"') return { value, position: i + 1 };
      if (text[i] === '\\' && ['"', '\\'].includes(text[i + 1])) value += text[++i];
      else value += text[i];
    }
    fail(line, 'ラベルの引用符を閉じてください。');
  }
  function labelValue(raw, line, warnings) {
    const value = raw.trim();
    if (!value.startsWith('"')) return decodeLabel(value, line, warnings);
    const quoted = readQuoted(value, 0, line);
    if (value.slice(quoted.position).trim()) fail(line, 'ラベルの引用符の後に不要な文字があります。');
    return decodeLabel(quoted.value, line, warnings);
  }
  function ids(value, line) {
    const result = value.split(',');
    if (result.some(item => !item || ID.exec(item)?.[0] !== item)) fail(line, 'IDには英数字・日本語・アンダースコアを使ってください。');
    return result;
  }
  function parseStyles(raw, line, warnings, edge = false) {
    const styles = {};
    for (const part of raw.split(/(?<!\\),/)) {
      const colon = part.indexOf(':');
      if (colon < 1) fail(line, 'スタイルは fill:#色,color:#色 のように指定してください。');
      const name = part.slice(0, colon).trim(), value = part.slice(colon + 1).trim().replace(/\\,/g, ',');
      if ((!edge && ['fill', 'color'].includes(name)) || (edge && name === 'stroke')) {
        if (COLOR.test(value)) styles[edge ? 'color' : name === 'fill' ? 'color' : 'textColor'] = value;
        else warning(warnings, line, `スタイル「${name}:${value}」は未対応です。色は#から始まる形式のみ反映します。`);
      } else if ((!edge && name === 'font-size') || (edge && name === 'stroke-width')) {
        const numeric = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(value);
        const number = numeric ? Number(numeric[1]) : NaN;
        if (number >= (edge ? .1 : 1) && number <= (edge ? 100 : 1000)) styles[edge ? 'strokeWidth' : 'fontSize'] = number;
        else warning(warnings, line, `スタイル「${name}:${value}」は範囲外または未対応なので反映しません。`);
      } else if (edge && name === 'stroke-dasharray') {
        if (value === 'none' || /^(?:0[ ,]*)+$/.test(value)) styles.lineStyle = 'solid';
        else if (/^\d+(?:\.\d+)?(?:[ ,]+\d+(?:\.\d+)?)*$/.test(value)) {
          styles.lineStyle = 'dashed';
          if (value !== '6 4') warning(warnings, line, '破線の間隔はボードの標準の間隔に置き換えます。');
        } else warning(warnings, line, '未対応の破線の指定を反映しません。');
      } else warning(warnings, line, `スタイル「${name}」はボードでは反映しません。`);
    }
    return styles;
  }

  function layout(nodes, edges, direction, line) {
    const ordered = [...nodes.values()], outgoing = new Map(), incoming = new Map(), ranks = new Map();
    for (const node of ordered) { outgoing.set(node.sourceId, []); incoming.set(node.sourceId, 0); ranks.set(node.sourceId, 0); }
    for (const edge of edges) {
      outgoing.get(edge.from).push(edge.to); incoming.set(edge.to, incoming.get(edge.to) + 1);
    }
    const queue = ordered.filter(node => incoming.get(node.sourceId) === 0).map(node => node.sourceId), visited = new Set();
    let cursor = 0, fallback = 0;
    while (visited.size < ordered.length) {
      if (cursor === queue.length) {
        while (visited.has(ordered[fallback].sourceId)) fallback++;
        queue.push(ordered[fallback].sourceId);
      }
      const id = queue[cursor++];
      if (visited.has(id)) continue;
      visited.add(id);
      for (const next of outgoing.get(id)) {
        if (visited.has(next)) continue;
        ranks.set(next, Math.max(ranks.get(next), ranks.get(id) + 1));
        incoming.set(next, incoming.get(next) - 1);
        if (incoming.get(next) === 0) queue.push(next);
      }
    }
    const horizontal = direction === 'LR' || direction === 'RL';
    const groups = new Map();
    for (const node of ordered) {
      const rank = ranks.get(node.sourceId);
      if (!groups.has(rank)) groups.set(rank, []);
      groups.get(rank).push(node);
    }
    let primary = 0;
    for (const rank of [...groups.keys()].sort((a, b) => a - b)) {
      let secondary = 0, extent = 0;
      for (const node of groups.get(rank)) {
        const item = node.item;
        item.x = horizontal ? primary : secondary; item.y = horizontal ? secondary : primary;
        secondary += (horizontal ? item.height : item.width) + 70;
        extent = Math.max(extent, horizontal ? item.width : item.height);
      }
      primary += extent + 120;
    }
    const width = Math.max(0, ...ordered.map(node => node.item.x + node.item.width));
    const height = Math.max(0, ...ordered.map(node => node.item.y + node.item.height));
    for (const { item } of ordered) {
      if (direction === 'RL') item.x = width - item.x - item.width;
      if (direction === 'BT') item.y = height - item.y - item.height;
      if (Math.max(item.x + item.width, item.y + item.height) > M.LIMITS.coordinate) fail(line, '図が大きすぎます。複数の図に分けてください。');
    }
  }

  function importFlowchart(source) {
    const parts = statements(source), first = parts.shift();
    if (!first) fail(1, 'flowchart LR などから始まるMermaidのコードを入力してください。');
    const header = /^(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)\b/.exec(first.text);
    if (!header) fail(first.line, '対応しているのは flowchart / graph の LR・RL・TD・TB・BT です。他の種類の図は読み込めません。');
    if (first.text.slice(header[0].length).trim()) parts.unshift({ text: first.text.slice(header[0].length).trim(), line: first.line });
    const direction = header[1], nodes = new Map(), edges = [], warnings = ['配置は接続関係から再計算します。Mermaidと同じ位置・サイズ・曲線にはなりません。'];
    const classes = new Map(), assignments = [], styles = [], edgeStyles = [];
    function limit(line) { if (nodes.size + edges.length > M.LIMITS.elements) fail(line, `図形と矢印は合計${M.LIMITS.elements}個以内にしてください。`); }
    function ensureNode(sourceId, line) {
      if (sourceId.length > 128) fail(line, '図形のIDは128文字以内にしてください。');
      if (sourceId === 'end') fail(line, 'end は予約語です。End などのIDに変更してください。');
      if (!nodes.has(sourceId)) { nodes.set(sourceId, { sourceId, line, item: M.createItem('rect', { text: sourceId }) }); limit(line); }
      return nodes.get(sourceId);
    }
    for (const statement of parts) {
      const { text, line } = statement;
      if (/^(?:subgraph|end|direction|click|flowchart|graph|sequenceDiagram|mindmap|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|journey|accTitle|accDescr)\b/.test(text)) fail(line, 'この構文は未対応です。subgraph・操作指定などを含まない基本のフローチャートにしてください。');
      let command;
      if ((command = /^(style|classDef|class|linkStyle)\s+(\S+)\s+([\s\S]+)$/.exec(text))) {
        const [, kind, targets, rest] = command;
        if (kind === 'classDef') for (const name of ids(targets, line)) classes.set(name, { value: parseStyles(rest, line, warnings), line });
        else if (kind === 'class') assignments.push({ targets: ids(targets, line), names: ids(rest.trim(), line), line });
        else if (kind === 'style') styles.push({ targets: ids(targets, line), value: parseStyles(rest, line, warnings), line });
        else {
          if (targets !== 'default' && !/^\d+(?:,\d+)*$/.test(targets)) fail(line, 'linkStyleは矢印の番号（0から）を指定してください。');
          edgeStyles.push({ targets, value: parseStyles(rest, line, warnings, true), line });
        }
        continue;
      }
      let position = 0;
      const skip = () => { while (/\s/.test(text[position] || '') && position < text.length) position++; };
      function readNode() {
        skip(); const match = ID.exec(text.slice(position));
        if (!match) fail(line, '図形のIDが必要です。複数端点（&）や拡張構文は未対応です。');
        position += match[0].length;
        const node = ensureNode(match[0], line); skip();
        const opening = text.startsWith('((', position) ? '((' : ['[', '(', '{'].includes(text[position]) ? text[position] : null;
        if (opening) {
          const closing = opening === '((' ? '))' : opening === '(' ? ')' : opening === '[' ? ']' : '}';
          position += opening.length; skip(); let raw;
          if (text[position] === '"') {
            const quoted = readQuoted(text, position, line); raw = quoted.value; position = quoted.position; skip();
          } else {
            const end = text.indexOf(closing, position);
            if (end < 0) fail(line, '図形の括弧を閉じてください。');
            raw = text.slice(position, end).trim();
            if (/[\[\](){}]/.test(raw) || (/^[\/\\]/.test(raw) && opening === '[')) fail(line, 'この図形は未対応です。四角・丸・ひし形を使い、ラベル内の括弧は引用符で囲んでください。');
            position = end;
          }
          if (!text.startsWith(closing, position)) fail(line, '引用符の後に図形の閉じ括弧が必要です。');
          position += closing.length;
          const label = decodeLabel(raw, line, warnings), type = opening === '((' ? 'ellipse' : opening === '{' ? 'diamond' : 'rect';
          const rows = label.split('\n'), longest = Math.max(0, ...rows.map(row => Array.from(row).length));
          const width = Math.min(420, Math.max(type === 'diamond' ? 260 : 220, longest * 20 + 48));
          const capacity = Math.max(1, Math.floor((width - 60) / (type === 'diamond' ? 30 : 20)));
          const wrappedLines = rows.reduce((sum, row) => sum + Math.max(1, Math.ceil(Array.from(row).length / capacity)), 0);
          const height = Math.max(type === 'diamond' ? 160 : 120, wrappedLines * 29 + 60);
          if (height > M.LIMITS.dimension) fail(line, 'ラベルが長すぎます。図形を分けてください。');
          node.item = M.createItem(type, { id: node.item.id, text: label, width, height });
          if (opening === '(') warning(warnings, line, '角丸四角はボードの四角として読み込みます。');
        }
        skip();
        while (text.startsWith(':::', position)) {
          position += 3;
          const name = ID.exec(text.slice(position));
          if (!name) fail(line, '::: の後にクラス名を指定してください。');
          assignments.push({ targets: [node.sourceId], names: [name[0]], line }); position += name[0].length; skip();
        }
        return node.sourceId;
      }
      function readEdge() {
        skip(); const remaining = text.slice(position);
        const direct = /^<?(?:-{2,}>|-{3,}|-\.+->|-\.+-)/.exec(remaining);
        let token, label = '';
        if (direct) {
          token = direct[0]; position += token.length;
          if (token.endsWith('-') && /^[ox]/.test(text.slice(position))) fail(line, '丸・交差の先端は未対応です。通常の線の終点IDなら、線とIDの間に空白を入れてください。');
          skip();
          if (token.startsWith('<') && !token.endsWith('>')) fail(line, 'この矢印の先端は未対応です。-->・<-->・--- を使ってください。');
          if (text[position] === '|') {
            position++; const start = position; let quoted = false;
            while (position < text.length) {
              if (text[position] === '\\' && quoted && ['"', '\\'].includes(text[position + 1])) { position += 2; continue; }
              if (text[position] === '"') quoted = !quoted;
              if (text[position] === '|' && !quoted) break;
              position++;
            }
            if (position === text.length) fail(line, '矢印のラベルを | で閉じてください。');
            label = labelValue(text.slice(start, position++), line, warnings);
          }
        } else if (remaining.startsWith('--') || remaining.startsWith('-.')) {
          const dashed = remaining.startsWith('-.'); position += 2; const start = position;
          let quoted = false, closing = null;
          while (position < text.length) {
            if (text[position] === '\\' && quoted && ['"', '\\'].includes(text[position + 1])) { position += 2; continue; }
            if (text[position] === '"') quoted = !quoted;
            if (!quoted) closing = (dashed ? /^\.+->|^\.+-/ : /^-{2,}>|^-{3,}/).exec(text.slice(position));
            if (closing) break;
            position++;
          }
          if (!closing) fail(line, '矢印は -->・-.->・---・<--> の形式で指定してください。');
          label = labelValue(text.slice(start, position), line, warnings); token = (dashed ? '-' : '') + closing[0]; position += closing[0].length;
        } else fail(line, '未対応の構文があります。矢印は -->・-.->・---・<--> を使ってください。複数端点（&）は分けて記述してください。');
        if (!['-->', '---', '<-->', '-.->', '-.-', '<-.->'].includes(token)) warning(warnings, line, '矢印の長さの指定は標準の間隔に置き換えます。');
        if (Array.from(label).length > M.LIMITS.arrowLabel) fail(line, '矢印のラベルは200文字以内にしてください。');
        return { label, lineStyle: token.includes('.') ? 'dashed' : 'solid', head: token.startsWith('<') ? 'both' : token.endsWith('>') ? 'end' : 'none', line };
      }
      let from = readNode();
      while (position < text.length) {
        const properties = readEdge(), to = readNode(); edges.push({ from, to, ...properties }); limit(line); from = to; skip();
      }
    }
    if (!nodes.size) fail(first.line, '少なくとも1つの図形を記述してください。');
    const assigned = new Set(assignments.flatMap(entry => entry.targets));
    if (classes.has('default')) for (const node of nodes.values()) if (!assigned.has(node.sourceId)) Object.assign(node.item, classes.get('default').value);
    for (const assignment of assignments) {
      for (const name of assignment.names) {
        if (!classes.has(name)) fail(assignment.line, `クラス「${name}」のclassDefがありません。`);
        for (const target of assignment.targets) {
          if (!nodes.has(target)) fail(assignment.line, `図形「${target}」が見つかりません。`);
          Object.assign(nodes.get(target).item, classes.get(name).value);
        }
      }
    }
    for (const style of styles) for (const target of style.targets) {
      if (!nodes.has(target)) fail(style.line, `図形「${target}」が見つかりません。`);
      Object.assign(nodes.get(target).item, style.value);
    }
    for (const style of edgeStyles) {
      const indices = style.targets === 'default' ? edges.map((_, index) => index) : style.targets.split(',').map(Number);
      for (const index of indices) {
        if (!edges[index]) fail(style.line, `矢印の番号 ${index} が見つかりません。`);
        Object.assign(edges[index], style.value);
      }
    }
    // Font styles may arrive after declarations; size every node using its final text and font.
    for (const node of nodes.values()) {
      const item = node.item, rows = item.text.split('\n');
      const longest = Math.max(0, ...rows.map(row => Array.from(row).length));
      item.width = Math.min(6000, Math.max(item.type === 'diamond' ? 260 : 220, longest * item.fontSize + 60));
      const capacity = Math.max(1, Math.floor((item.width - 60) / (item.fontSize * (item.type === 'diamond' ? 1.5 : 1))));
      const wrappedLines = rows.reduce((sum, row) => sum + Math.max(1, Math.ceil(Array.from(row).length / capacity)), 0);
      item.height = Math.max(item.type === 'diamond' ? 160 : 120, wrappedLines * item.fontSize * 1.45 + 60);
      if (item.height > M.LIMITS.dimension) fail(node.line, 'ラベルが長すぎます。図形を分けてください。');
    }
    layout(nodes, edges, direction, first.line);
    const doc = M.createDocument('Mermaidから読み込んだボード');
    doc.elements = [...nodes.values()].map(node => node.item);
    for (const edge of edges) {
      const from = nodes.get(edge.from).item, to = nodes.get(edge.to).item;
      doc.elements.push(M.createItem('arrow', { from: { ...center(from), elementId: from.id }, to: { ...center(to), elementId: to.id },
        label: edge.label, lineStyle: edge.lineStyle, head: edge.head, ...(edge.color ? { color: edge.color } : {}), ...(edge.strokeWidth ? { strokeWidth: edge.strokeWidth } : {}) }));
    }
    return { document: doc, warnings: [...new Set(warnings)] };
  }

  function encodeLabel(text) {
    return Array.from(text, character => character === '\n' ? '<br/>' : /[&"'#;|<>\[\]{}()`\\\r]/.test(character) ? `#${character.codePointAt(0)};` : character).join('');
  }
  function exportFlowchart(document, direction = 'LR') {
    if (!DIRECTIONS.has(direction)) throw new Error('向きはLR・RL・TD・TB・BTから選んでください。');
    const doc = M.parse(M.serialize(document)), nodes = doc.elements.filter(item => NODE_TYPES.has(item.type));
    if (!nodes.length) throw new Error('Mermaidに書き出せる図形・付箋・テキストを追加してください。');
    const warnings = ['位置・サイズ・重なり順はMermaidには保存されません。Mermaid側で配置を決めます。'];
    const images = doc.elements.filter(item => item.type === 'image').length;
    if (images) warnings.push(`画像${images}個はMermaidに含めません。`);
    const simplified = nodes.filter(item => item.type === 'note' || item.type === 'text').length;
    if (simplified) warnings.push(`付箋・テキスト${simplified}個は四角い図形として書き出します。`);
    const mapping = new Map(nodes.map((item, index) => [item.id, `n${index + 1}`]));
    const lines = [`flowchart ${direction}`], nodeStyles = [], linkStyles = [];
    for (const item of nodes) {
      const id = mapping.get(item.id), text = `"${encodeLabel(item.text)}"`;
      lines.push(`  ${id}${item.type === 'ellipse' ? `((${text}))` : item.type === 'diamond' ? `{${text}}` : `[${text}]`}`);
      const fill = item.type === 'text' ? '#ffffff' : item.color;
      const ink = item.type === 'text' ? item.color : item.textColor || M.DEFAULTS.textColor;
      nodeStyles.push(`  style ${id} fill:${fill},color:${ink},font-size:${item.fontSize}px`);
    }
    let skipped = 0, edgeIndex = 0;
    for (const item of doc.elements.filter(item => item.type === 'arrow')) {
      if (!mapping.has(item.from.elementId) || !mapping.has(item.to.elementId)) { skipped++; continue; }
      const dashed = item.lineStyle === 'dashed', head = item.head || 'end';
      const token = head === 'both' ? '<-->' : head === 'none' ? (dashed ? '-.-' : '---') : (dashed ? '-.->' : '-->');
      const label = item.label ? `|"${encodeLabel(item.label)}"|` : '';
      lines.push(`  ${mapping.get(item.from.elementId)} ${token}${label} ${mapping.get(item.to.elementId)}`);
      linkStyles.push(`  linkStyle ${edgeIndex++} stroke:${item.color},stroke-width:${item.strokeWidth}px${dashed && head === 'both' ? ',stroke-dasharray:6 4' : ''}`);
    }
    if (skipped) warnings.push(`両端が書き出す図形につながっていない矢印${skipped}本は含めません。`);
    return { source: [...lines, ...nodeStyles, ...linkStyles].join('\n') + '\n', warnings };
  }
  return { importFlowchart, exportFlowchart };
});
