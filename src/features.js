(function (root, factory) {
  'use strict';
  const commonJS = typeof module === 'object' && module.exports;
  const api = factory(commonJS ? require('./model.js') : root.BrainstormorModel);
  if (commonJS) module.exports = api;
  if (root) root.BrainstormorFeatures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  if (!M) throw new Error('BrainstormorModelを先に読み込んでください。');
  const SHAPES = new Set(['rect', 'ellipse', 'diamond', 'note']);
  const DIRECTIONS = new Set(['right', 'down', 'left', 'up']);
  const ALIGNMENTS = new Set(['left', 'center', 'right', 'top', 'middle', 'bottom', 'distribute-x', 'distribute-y']);
  const templates = Object.freeze([
    Object.freeze({ id: 'mindmap', title: 'アイデアマップ', description: 'テーマを中心に、気になることや試したいことを広げます。', kind: 'mindmap' }),
    Object.freeze({ id: 'flow', title: '判断フロー', description: '判断の条件と、その先の行動を整理します。', kind: 'flow' }),
    Object.freeze({ id: 'retro', title: 'ふりかえり', description: '続けること、困ったこと、次に試すことを書き出します。', kind: 'retro' })
  ]);

  function center(item) { return { x: item.x + item.width / 2, y: item.y + item.height / 2 }; }
  function connect(from, to, label = '') {
    return M.createItem('arrow', { from: { ...center(from), elementId: from.id }, to: { ...center(to), elementId: to.id }, strokeWidth: 3, label });
  }
  function heading(text, x, y, width, fontSize = 24, color = '#24334a') {
    return M.createItem('text', { x, y, width, height: fontSize * 1.5 + 20, text, fontSize, color });
  }
  function createTemplate(id) {
    const template = templates.find(item => item.id === id);
    if (!template) throw new Error('このテンプレートは見つかりません。');
    const doc = M.createDocument(template.title);
    const title = heading(template.title, 0, 0, 1000, 32);
    const subtitle = heading(template.description, 0, 65, 1000, 18, '#526076');
    if (id === 'mindmap') {
      const root = M.createItem('ellipse', { x: 385, y: 300, width: 230, height: 150, text: '考えたいテーマ\nここから広げる', color: '#d7f1e3', fontSize: 22 });
      const branches = [
        M.createItem('rect', { x: 0, y: 170, width: 260, height: 125, text: '誰のため？\n使う人・困っている人', color: '#daeafd' }),
        M.createItem('rect', { x: 740, y: 170, width: 260, height: 125, text: '何を実現したい？\nうれしい変化・ゴール', color: '#eee0ff' }),
        M.createItem('rect', { x: 0, y: 470, width: 260, height: 125, text: 'どんな方法がある？\n思いつくままに書く', color: '#fff2aa' }),
        M.createItem('rect', { x: 740, y: 470, width: 260, height: 125, text: 'まず何を試す？\n小さな一歩を決める', color: '#fbdde9' })
      ];
      doc.elements = [title, subtitle, ...branches.map(branch => connect(root, branch)), root, ...branches];
    } else if (id === 'flow') {
      const start = M.createItem('ellipse', { x: 385, y: 150, width: 230, height: 90, text: '検討したいアイデア', color: '#daeafd' });
      const decision = M.createItem('diamond', { x: 385, y: 290, width: 230, height: 155, text: '目的に\n合っている？', color: '#eee0ff' });
      const revise = M.createItem('rect', { x: 40, y: 495, width: 280, height: 120, text: '見直す\n条件や範囲を調整', color: '#fff2aa' });
      const tryIt = M.createItem('rect', { x: 680, y: 495, width: 280, height: 120, text: '小さく試す\nまず一歩を決める', color: '#d7f1e3' });
      doc.elements = [title, subtitle, connect(start, decision), connect(decision, revise, 'いいえ'), connect(decision, tryIt, 'はい'), start, decision, revise, tryIt];
    } else {
      const columns = [
        { x: 0, title: 'Keep / 続ける', color: '#d7f1e3', notes: ['うまくいったこと\n続けたい工夫は？', '助けになったこと\n誰に感謝したい？'] },
        { x: 350, title: 'Problem / 困ったこと', color: '#fbdde9', notes: ['困った場面\n何が起きた？', 'つまずいた理由\n変えられそうなことは？'] },
        { x: 700, title: 'Try / 次に試す', color: '#daeafd', notes: ['次に試したいこと\n小さく始めるなら？', '最初の一歩\n誰が・いつまでに？'] }
      ];
      doc.elements = [title, subtitle];
      for (const column of columns) {
        doc.elements.push(heading(column.title, column.x, 160, 300, 22));
        column.notes.forEach((text, index) => doc.elements.push(M.createItem('note', { x: column.x, y: 240 + index * 200, width: 300, height: 155, text, color: column.color, fontSize: 20 })));
      }
    }
    return doc;
  }

  function overlaps(a, b, padding = 0) {
    return a.x < b.x + b.width + padding && a.x + a.width + padding > b.x
      && a.y < b.y + b.height + padding && a.y + a.height + padding > b.y;
  }
  function branchElements(elements, sourceId, direction = 'right', dimensions = null) {
    const source = elements.find(item => item.id === sourceId);
    if (!source || !SHAPES.has(source.type) || !DIRECTIONS.has(direction)) return [];
    const horizontal = direction === 'right' || direction === 'left';
    const position = { x: source.x, y: source.y, width: dimensions?.width ?? source.width, height: dimensions?.height ?? source.height };
    if (![position.width, position.height].every(value => Number.isFinite(value) && value > 0 && value <= M.LIMITS.dimension)) return [];
    if (direction === 'right') position.x += source.width + 100;
    if (direction === 'left') position.x -= position.width + 100;
    if (direction === 'down') position.y += source.height + 100;
    if (direction === 'up') position.y -= position.height + 100;
    const obstacles = elements.filter(item => item.type !== 'arrow');
    // Each step passes the far edge of at least one obstacle, so the scan terminates.
    for (let attempt = 0; attempt <= obstacles.length; attempt++) {
      const collisions = obstacles.filter(item => overlaps(position, item, 24));
      if (!collisions.length) break;
      if (horizontal) position.y = Math.max(...collisions.map(item => item.y + item.height)) + 24;
      else position.x = Math.max(...collisions.map(item => item.x + item.width)) + 24;
    }
    const childCenter = center(position), sourceCenter = center(source);
    if ([position.x, position.y, childCenter.x, childCenter.y, sourceCenter.x, sourceCenter.y].some(value => Math.abs(value) > M.LIMITS.coordinate)) return [];
    const child = M.createItem(source.type, { ...position, text: '新しいアイデア', color: source.color, fontSize: source.fontSize,
      ...(source.textColor === undefined ? {} : { textColor: source.textColor }) });
    return [child, connect(source, child)];
  }

  function alignElements(elements, ids, mode) {
    const result = elements.slice();
    if (!ALIGNMENTS.has(mode)) return result;
    const selection = new Set(ids);
    const items = elements.filter(item => selection.has(item.id) && item.type !== 'arrow');
    const distributing = mode === 'distribute-x' || mode === 'distribute-y';
    if (items.length < (distributing ? 3 : 2)) return result;
    const positions = new Map();
    if (distributing) {
      const axis = mode === 'distribute-x' ? 'x' : 'y';
      const size = axis === 'x' ? 'width' : 'height';
      const ordered = items.slice().sort((a, b) => a[axis] - b[axis]);
      const first = ordered[0], last = ordered[ordered.length - 1];
      const occupied = ordered.reduce((sum, item) => sum + item[size], 0);
      const gap = (last[axis] + last[size] - first[axis] - occupied) / (ordered.length - 1);
      let cursor = first[axis] + first[size] + gap;
      for (let index = 1; index < ordered.length - 1; index++) {
        const item = ordered[index];
        positions.set(item.id, { [axis]: cursor });
        cursor += item[size] + gap;
      }
    } else {
      const left = Math.min(...items.map(item => item.x)), top = Math.min(...items.map(item => item.y));
      const right = Math.max(...items.map(item => item.x + item.width)), bottom = Math.max(...items.map(item => item.y + item.height));
      for (const item of items) {
        const position = mode === 'left' ? { x: left } : mode === 'center' ? { x: (left + right - item.width) / 2 }
          : mode === 'right' ? { x: right - item.width } : mode === 'top' ? { y: top }
          : mode === 'middle' ? { y: (top + bottom - item.height) / 2 } : { y: bottom - item.height };
        positions.set(item.id, position);
      }
    }
    return result.map(item => positions.has(item.id) ? { ...item, ...positions.get(item.id) } : item);
  }

  function normalized(text) { return text.normalize('NFKC').toLowerCase(); }
  function searchElements(elements, query) {
    if (typeof query !== 'string') return [];
    const needle = normalized(query).trim();
    if (!needle) return [];
    return elements.filter(item => {
      const text = item.type === 'arrow' ? item.label : item.text;
      return typeof text === 'string' && normalized(text).includes(needle);
    }).map(item => item.id);
  }

  return { templates, createTemplate, branchElements, alignElements, searchElements };
});
