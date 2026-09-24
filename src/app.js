(() => {
  'use strict';
  const M = window.BrainstormorModel;
  const F = window.BrainstormorFeatures;
  const $ = id => document.getElementById(id);
  const stage = $('stage'), canvas = $('canvas'), world = $('world'), overlay = $('overlay');
  const editor = $('text-editor');
  const NS = 'http://www.w3.org/2000/svg';
  const MAX_BYTES = 40 * 1024 * 1024;
  let doc = M.createDocument(), selected = new Set(), tool = 'select';
  let history = [], historyIndex = -1, savedSnapshot = '', autosaveTimer, toastTimer;
  let gesture = null, editing = null, spacePressed = false;
  let localSaved = false, autosaveFailed = false, revision = 0, dragDepth = 0;
  let lastPointer = null, restoring = true, clipboardElements = null, dbPromise;
  let persistenceQueue = Promise.resolve();
  let saving = false, lastTap = null;
  let searchMatches = [], searchIndex = -1;
  const diagramPreviews = new Map();
  document.querySelector('.app-shell').inert = true;
  const measure = document.createElement('canvas').getContext('2d');
  const fonts = '-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
  const isShape = el => ['rect', 'ellipse', 'diamond'].includes(typeof el === 'string' ? el : el.type);
  const hasText = el => isShape(el) || ['note', 'text'].includes(typeof el === 'string' ? el : el.type);
  const shapeColors = ['#daeafd', '#d7f1e3', '#eee0ff', '#fbdde9', '#fff2aa', '#ffffff'];
  const palettes = {
    rect: shapeColors, ellipse: shapeColors, diamond: shapeColors,
    note: ['#fff2aa', '#d7f1e3', '#daeafd', '#fbdde9', '#eee0ff', '#ffffff'],
    text: ['#24334a', '#ffffff', '#137b6b', '#be454c', '#4664d3', '#9b5bd3'],
    arrow: ['#526076', '#137b6b', '#be454c', '#4664d3', '#9b5bd3', '#e39c25'],
  };

  function svg(tag, attrs = {}, content) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function toast(message) {
    $('toast').textContent = message; $('toast').classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3600);
  }
  function contentSnapshot(value = doc) { return JSON.stringify({ title: value.title, elements: value.elements }); }
  function fileDirty() { return contentSnapshot() !== savedSnapshot; }
  function commit() {
    const snapshot = contentSnapshot();
    if (history[historyIndex] !== snapshot) {
      history = history.slice(0, historyIndex + 1); history.push(snapshot);
      let bytes = history.reduce((sum, x) => sum + x.length * 2, 0);
      while (history.length > 2 && (history.length > 50 || bytes > 60 * 1024 * 1024)) bytes -= history.shift().length * 2;
      historyIndex = history.length - 1;
      revision++; localSaved = false; scheduleAutosave();
    }
    updateUI(); render();
  }
  function resetHistory() { history = [contentSnapshot()]; historyIndex = 0; }
  function undo(direction = -1) {
    finishEdit();
    const index = historyIndex + direction;
    if (index < 0 || index >= history.length) return;
    const state = JSON.parse(history[index]);
    doc.title = state.title; doc.elements = state.elements; historyIndex = index;
    selected.clear(); revision++; localSaved = false; scheduleAutosave(); updateUI(); render();
  }
  function status() {
    const unsaved = fileDirty();
    $('save-status').textContent = autosaveFailed ? 'ファイルに保存してください' : localSaved ? (unsaved ? 'ブラウザ保存済み · ファイル未保存' : '保存済み') : (unsaved ? '未保存の変更あり' : '保存済み');
    $('save-status').classList.toggle('unsaved', unsaved);
    document.title = `${unsaved ? '● ' : ''}${doc.title || '無題のボード'} — brainstormor`;
  }
  function updateUI() {
    if (document.activeElement !== $('board-title')) $('board-title').value = doc.title;
    $('undo-btn').disabled = historyIndex <= 0;
    $('redo-btn').disabled = historyIndex >= history.length - 1;
    $('item-count').textContent = `${doc.elements.length} オブジェクト`;
    $('empty-state').hidden = doc.elements.length > 0;
    $('zoom-label').textContent = `${Math.round(doc.viewport.zoom * 100)}%`;
    status(); updateSearch(); updateInspector();
  }
  function getDB() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open('brainstormor-offline', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('boards');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('保存領域を開けませんでした'));
      } catch (e) { reject(e); }
    });
    return dbPromise;
  }
  async function readLocal() {
    let fallback = null, primary = null;
    try { fallback = JSON.parse(localStorage.getItem('brainstormor-backup')); } catch { /* No readable fallback. */ }
    try {
      const db = await getDB();
      primary = await new Promise((resolve, reject) => {
        const request = db.transaction('boards').objectStore('boards').get('last-board');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch { /* Try the independently stored fallback. */ }
    return [primary, fallback].filter(Boolean).sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || ''))).find(payload => {
      try { M.parse(JSON.stringify(payload.document)); return true; } catch { return false; }
    }) || null;
  }
  function scheduleAutosave() { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(autosave, 400); }
  function autosave() {
    if (restoring) return;
    clearTimeout(autosaveTimer);
    const captureRevision = revision;
    const payload = { document: M.clone(doc), savedSnapshot, updated: new Date().toISOString() };
    persistenceQueue = persistenceQueue.catch(() => {}).then(async () => {
      try {
        try {
          const db = await getDB();
          await new Promise((resolve, reject) => {
            const transaction = db.transaction('boards', 'readwrite');
            transaction.objectStore('boards').put(payload, 'last-board');
            transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
        } catch { localStorage.setItem('brainstormor-backup', JSON.stringify(payload)); }
        if (revision === captureRevision) { localSaved = true; autosaveFailed = false; }
      } catch {
        if (!autosaveFailed) toast('ブラウザの保存容量が不足しています。「保存」でファイルに残してください。');
        autosaveFailed = true;
      }
      status();
    });
  }
  const point = event => {
    const rect = stage.getBoundingClientRect();
    return { x: (event.clientX - rect.left - doc.viewport.x) / doc.viewport.zoom, y: (event.clientY - rect.top - doc.viewport.y) / doc.viewport.zoom };
  };
  const center = () => ({ x: (stage.clientWidth / 2 - doc.viewport.x) / doc.viewport.zoom, y: (stage.clientHeight / 2 - doc.viewport.y) / doc.viewport.zoom });
  const getElement = id => doc.elements.find(element => element.id === id);
  function boxAt(p, exclude) {
    return [...doc.elements].reverse().find(el => {
      if (el.type === 'arrow' || el.id === exclude) return false;
      const dx = Math.abs(p.x - el.x - el.width / 2) / (el.width / 2), dy = Math.abs(p.y - el.y - el.height / 2) / (el.height / 2);
      return el.type === 'ellipse' ? dx * dx + dy * dy <= 1 : el.type === 'diamond' ? dx + dy <= 1 : dx <= 1 && dy <= 1;
    });
  }
  function endpoint(p, exclude) {
    const hit = boxAt(p, exclude);
    return { x: p.x, y: p.y, ...(hit ? { elementId: hit.id } : {}) };
  }
  function wrapText(text, maxWidth, fontSize) {
    measure.font = `${fontSize}px ${fonts}`;
    const lines = [];
    for (const paragraph of String(text).split('\n')) {
      let line = '';
      for (const character of Array.from(paragraph)) {
        if (line && measure.measureText(line + character).width > maxWidth) { lines.push(line); line = ''; }
        line += character;
      }
      lines.push(line);
    }
    return lines;
  }
  function textLayout(el) {
    const pad = el.type === 'note' ? 20 : el.type === 'rect' ? 16 : 10;
    const width = Math.max(10, el.type === 'diamond' ? el.width * .56 : el.type === 'ellipse' ? el.width * .72 : el.width - pad * 2);
    const lines = wrapText(el.text || '', width, el.fontSize);
    const lineHeight = el.fontSize * 1.45;
    const centered = isShape(el);
    return { width, lines, lineHeight, x: centered ? (el.width - width) / 2 : pad, y: centered ? (el.height - lines.length * lineHeight) / 2 : pad, centered };
  }
  function fitTextHeight(el) {
    if (!hasText(el)) return;
    const layout = textLayout(el);
    const contentHeight = layout.lines.length * layout.lineHeight;
    if (isShape(el)) el.height = Math.max(el.height, el.type === 'diamond' ? contentHeight * 2 + 32 : el.type === 'ellipse' ? contentHeight / .65 + 20 : contentHeight + 32);
    else el.height = Math.max(el.type === 'note' ? 100 : 44, contentHeight + (el.type === 'note' ? 40 : 20));
  }
  function diagramPreview(el, rendered) {
    const parsed = new DOMParser().parseFromString(rendered.svg, 'image/svg+xml');
    const viewBox = parsed.documentElement.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    const naturalWidth = viewBox?.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : 720;
    const naturalHeight = viewBox?.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : 480;
    const scale = Math.min(720 / naturalWidth, 520 / naturalHeight);
    return {
      source: el.source,
      image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`,
      width: Math.max(240, Math.round(naturalWidth * scale)),
      height: Math.max(160, Math.round(naturalHeight * scale)),
    };
  }
  function ensureDiagramPreview(el) {
    const cached = diagramPreviews.get(el.id);
    if (cached?.source === el.source) return cached.promise;
    const entry = { source: el.source };
    diagramPreviews.set(el.id, entry);
    entry.promise = window.BrainstormorMermaidRenderer.render(el.source).then(rendered => {
      if (diagramPreviews.get(el.id) === entry) {
        Object.assign(entry, diagramPreview(el, rendered));
        render();
      }
      return entry;
    }, failure => {
      if (diagramPreviews.get(el.id) === entry) { entry.error = failure; render(); }
      throw failure;
    });
    return entry.promise;
  }
  function renderElement(el) {
    const group = svg('g', { 'data-element-id': el.id, class: `board-element element-${el.type}` });
    if (el.type === 'arrow') {
      const { from, to } = M.arrowEndpoints(el, doc.elements);
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
      const nx = length ? dx / length : 1, ny = length ? dy / length : 0;
      const head = Math.min(16, length / 2), color = el.color || '#526076';
      const endHead = el.head !== 'none', startHead = el.head === 'both';
      group.append(svg('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: 'transparent', 'stroke-width': Math.max(18, 18 / doc.viewport.zoom), 'pointer-events': 'stroke' }));
      group.append(svg('line', { x1: from.x + (startHead ? nx * head * .6 : 0), y1: from.y + (startHead ? ny * head * .6 : 0), x2: to.x - (endHead ? nx * head * .6 : 0), y2: to.y - (endHead ? ny * head * .6 : 0), stroke: color, 'stroke-width': el.strokeWidth || 3, 'stroke-linecap': 'round', ...(el.lineStyle === 'dashed' ? { 'stroke-dasharray': '10 7' } : {}), 'pointer-events': 'none' }));
      function appendHead(tip, vx, vy) {
        group.append(svg('path', { d: `M ${tip.x} ${tip.y} L ${tip.x - vx * head - vy * head * .42} ${tip.y - vy * head + vx * head * .42} L ${tip.x - vx * head + vy * head * .42} ${tip.y - vy * head - vx * head * .42} Z`, fill: color, 'pointer-events': 'none' }));
      }
      if (endHead) appendHead(to, nx, ny);
      if (startHead) appendHead(from, -nx, -ny);
      const label = M.arrowLabelLayout(el, doc.elements);
      if (label) {
        group.append(svg('rect', { x: label.x, y: label.y, width: label.width, height: label.height, rx: 6, fill: '#ffffff', stroke: color, 'stroke-opacity': .18 }));
        const text = svg('text', { x: label.x + label.width / 2, y: label.y + 22, 'text-anchor': 'middle', 'font-size': 16, 'font-family': 'ui-monospace,SFMono-Regular,Consolas,monospace', fill: color, 'pointer-events': 'none' });
        label.lines.forEach((line, i) => text.append(svg('tspan', { x: label.x + label.width / 2, dy: i ? label.lineHeight : 0 }, line || '\u00a0')));
        group.append(text);
      }
      return group;
    }
    group.setAttribute('transform', `translate(${el.x} ${el.y})`);
    if (el.type === 'note') {
      group.append(svg('rect', { x: 0, y: 3, width: el.width, height: el.height, rx: 5, fill: '#263348', opacity: .06, 'pointer-events': 'none' }));
      group.append(svg('rect', { width: el.width, height: el.height, rx: 5, fill: el.color, stroke: '#263348', 'stroke-opacity': .08 }));
      group.append(svg('path', { d: `M 0 5 Q 0 0 5 0 L ${el.width - 5} 0 Q ${el.width} 0 ${el.width} 5 L ${el.width} 9 L 0 9 Z`, fill: '#fff', opacity: .25 }));
    } else if (isShape(el)) {
      const attrs = { fill: el.color, stroke: '#526076', 'stroke-opacity': .28, 'stroke-width': 1.5 };
      if (el.type === 'rect') group.append(svg('rect', { width: el.width, height: el.height, rx: 12, ...attrs }));
      if (el.type === 'ellipse') group.append(svg('ellipse', { cx: el.width / 2, cy: el.height / 2, rx: el.width / 2, ry: el.height / 2, ...attrs }));
      if (el.type === 'diamond') group.append(svg('path', { d: `M ${el.width / 2} 0 L ${el.width} ${el.height / 2} L ${el.width / 2} ${el.height} L 0 ${el.height / 2} Z`, ...attrs }));
    } else if (el.type === 'image') {
      group.append(svg('rect', { width: el.width, height: el.height, rx: 4, fill: '#fff', stroke: '#dce2e8' }));
      group.append(svg('image', { width: el.width, height: el.height, href: el.src, preserveAspectRatio: 'none' }));
    } else if (el.type === 'diagram') {
      const preview = diagramPreviews.get(el.id);
      if (preview?.source !== el.source) ensureDiagramPreview(el).catch(() => {});
      group.append(svg('title', {}, `${el.name}。ダブルクリックで編集`));
      group.append(svg('rect', { width: el.width, height: el.height, rx: 8, fill: '#fff', stroke: '#dce2e8' }));
      if (preview?.source === el.source && preview.image) {
        group.append(svg('image', { x: 8, y: 8, width: Math.max(1, el.width - 16), height: Math.max(1, el.height - 16), href: preview.image, preserveAspectRatio: 'xMidYMid meet', 'pointer-events': 'none' }));
      } else {
        const message = preview?.error ? '図を表示できません。ダブルクリックでコードを確認' : 'Mermaid図を描画中…';
        group.append(svg('text', { x: el.width / 2, y: el.height / 2, 'text-anchor': 'middle', fill: '#526076', 'font-size': 16, 'pointer-events': 'none' }, message));
      }
    } else {
      group.append(svg('rect', { width: el.width, height: el.height, rx: 3, fill: 'transparent' }));
    }
    if (hasText(el)) {
      const layout = textLayout(el);
      const text = svg('text', { x: layout.centered ? el.width / 2 : layout.x, y: layout.y + el.fontSize * 1.08, fill: el.type === 'text' ? el.color : (el.textColor || '#24334a'), 'font-family': fonts, 'font-size': el.fontSize, 'text-anchor': layout.centered ? 'middle' : 'start', 'pointer-events': 'none', 'xml:space': 'preserve' });
      if (el.type === 'text' && el.color === '#ffffff') { text.setAttribute('paint-order', 'stroke'); text.setAttribute('stroke', '#17212e88'); text.setAttribute('stroke-width', '3'); text.setAttribute('stroke-linejoin', 'round'); }
      layout.lines.forEach((line, index) => text.append(svg('tspan', { x: layout.centered ? el.width / 2 : layout.x, dy: index ? layout.lineHeight : 0 }, line || '\u00a0')));
      group.append(text);
    }
    return group;
  }
  function render() {
    const { x, y, zoom } = doc.viewport;
    world.setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
    overlay.setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
    stage.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
    stage.style.backgroundPosition = `${x}px ${y}px`;
    world.replaceChildren(...doc.elements.map(renderElement));
    overlay.replaceChildren();
    if (!$('search-panel').hidden) for (const id of searchMatches) {
      const el = getElement(id); if (!el) continue;
      const b = elementBounds(el);
      overlay.append(svg('rect', { x: b.x - 7 / zoom, y: b.y - 7 / zoom, width: b.width + 14 / zoom, height: b.height + 14 / zoom, rx: 8 / zoom, fill: '#f4be3215', stroke: id === searchMatches[searchIndex] ? '#cf8b13' : '#eac777', 'stroke-width': (id === searchMatches[searchIndex] ? 2.5 : 1.5) / zoom, 'pointer-events': 'none' }));
    }
    for (const id of selected) {
      const el = getElement(id); if (!el) continue;
      if (el.type === 'arrow') {
        const endpoints = M.arrowEndpoints(el, doc.elements);
        overlay.append(svg('line', { x1: endpoints.from.x, y1: endpoints.from.y, x2: endpoints.to.x, y2: endpoints.to.y, stroke: '#138776', 'stroke-width': 1 / zoom, 'stroke-dasharray': `${5 / zoom} ${4 / zoom}`, 'pointer-events': 'none' }));
        for (const end of ['from', 'to']) overlay.append(svg('circle', { cx: endpoints[end].x, cy: endpoints[end].y, r: 6 / zoom, fill: 'white', stroke: '#138776', 'stroke-width': 2 / zoom, 'data-handle': end, 'data-id': el.id, cursor: 'crosshair' }));
      } else {
        overlay.append(svg('rect', { x: el.x - 3 / zoom, y: el.y - 3 / zoom, width: el.width + 6 / zoom, height: el.height + 6 / zoom, rx: 6 / zoom, fill: 'none', stroke: '#138776', 'stroke-width': 1.5 / zoom, 'pointer-events': 'none' }));
        if (selected.size === 1) overlay.append(svg('rect', { x: el.x + el.width - 5 / zoom, y: el.y + el.height - 5 / zoom, width: 10 / zoom, height: 10 / zoom, rx: 2 / zoom, fill: 'white', stroke: '#138776', 'stroke-width': 1.5 / zoom, 'data-handle': 'resize', 'data-id': el.id, cursor: 'nwse-resize' }));
        if (selected.size === 1 && (isShape(el) || el.type === 'note') && tool === 'select' && !editing) {
          for (const direction of ['right', 'down']) {
            const cx = direction === 'right' ? el.x + el.width + 23 / zoom : el.x + el.width / 2;
            const cy = direction === 'down' ? el.y + el.height + 23 / zoom : el.y + el.height / 2;
            const handle = svg('g', { 'data-handle': `branch-${direction}`, 'data-id': el.id, cursor: 'pointer' });
            handle.append(svg('title', {}, direction === 'right' ? '右にアイデアを追加 (Tab)' : '下にアイデアを追加 (Shift+Tab)'));
            handle.append(svg('circle', { cx, cy, r: 10 / zoom, fill: '#138776', 'data-handle': `branch-${direction}`, 'data-id': el.id }));
            handle.append(svg('path', { d: `M ${cx - 4 / zoom} ${cy} H ${cx + 4 / zoom} M ${cx} ${cy - 4 / zoom} V ${cy + 4 / zoom}`, stroke: '#fff', 'stroke-width': 1.5 / zoom, 'pointer-events': 'none' }));
            overlay.append(handle);
          }
        }
      }
    }
    if (gesture?.type === 'marquee') {
      const a = gesture.start, b = gesture.current;
      overlay.append(svg('rect', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y), fill: '#13877612', stroke: '#138776', 'stroke-width': 1 / zoom, 'pointer-events': 'none' }));
    }
    $('zoom-label').textContent = `${Math.round(zoom * 100)}%`;
    positionEditor();
  }
  function setTool(value) {
    finishEdit(); tool = value;
    document.querySelectorAll('[data-tool]').forEach(button => { button.classList.toggle('active', button.dataset.tool === tool); button.setAttribute('aria-pressed', String(button.dataset.tool === tool)); });
    stage.dataset.tool = tool;
    stage.style.cursor = tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : ['arrow', 'note', 'rect', 'ellipse', 'diamond'].includes(tool) ? 'crosshair' : 'default';
  }
  function addItem(type, p = center(), overrides = {}, edit = false) {
    if (doc.elements.length >= 5000) { toast('1つのボードに置ける上限は5,000個です。'); return; }
    const element = M.createItem(type, { x: p.x, y: p.y, ...overrides });
    doc.elements.push(element); selected = new Set([element.id]);
    commit(); setTool('select');
    if (edit) editText(element, true);
    return element;
  }
  function positionEditor() {
    if (!editing) return;
    const el = getElement(editing.id); if (!el) return;
    const z = doc.viewport.zoom, layout = textLayout(el);
    editor.style.left = `${doc.viewport.x + (el.x + layout.x) * z}px`;
    editor.style.top = `${doc.viewport.y + (el.y + layout.y) * z}px`;
    editor.style.width = `${Math.max(20, layout.width * z)}px`;
    editor.style.height = `${Math.max(layout.lines.length * layout.lineHeight, el.fontSize * 1.6) * z + 5}px`;
    editor.style.fontSize = `${el.fontSize * z}px`;
    editor.style.lineHeight = '1.45'; editor.style.padding = '0'; editor.style.border = '0';
    editor.style.textAlign = layout.centered ? 'center' : 'left';
    editor.style.color = el.type === 'text' ? el.color : (el.textColor || '#24334a');
    editor.style.background = el.type === 'text' ? '#ffffffee' : el.color;
    if (el.type === 'text' && el.color === '#ffffff') editor.style.background = '#354258e8';
    const rendered = [...world.children].find(node => node.getAttribute('data-element-id') === el.id);
    if (rendered) { const text = rendered.querySelector('text'); if (text) text.style.visibility = 'hidden'; }
  }
  function editText(el, selectAll = false) {
    if (!el || !hasText(el)) return;
    finishEdit(); selected = new Set([el.id]); editing = { id: el.id, original: el.text, height: el.height };
    editor.value = el.text; editor.hidden = false; updateUI(); render();
    editor.focus(); if (selectAll) editor.select(); else editor.setSelectionRange(editor.value.length, editor.value.length);
  }
  function finishEdit(cancel = false) {
    if (!editing) return;
    const el = getElement(editing.id);
    if (el) {
      el.text = cancel ? editing.original : editor.value;
      if (cancel) el.height = editing.height;
      else fitTextHeight(el);
    }
    editing = null; editor.hidden = true;
    if (el) commit();
  }
  editor.addEventListener('input', () => {
    const el = getElement(editing?.id); if (!el) return;
    el.text = editor.value; fitTextHeight(el); positionEditor();
  });
  editor.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishEdit(true); stage.focus(); }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finishEdit(); stage.focus(); }
  });
  editor.addEventListener('blur', () => finishEdit());

  canvas.addEventListener('pointerdown', event => {
    if (restoring || (event.button !== 0 && event.button !== 1)) return;
    finishEdit(); stage.focus({ preventScroll: true });
    const p = point(event); lastPointer = p;
    const target = event.target.closest('[data-element-id]');
    const id = target?.getAttribute('data-element-id');
    const handle = event.target.getAttribute('data-handle');
    if (event.button === 1 || spacePressed || tool === 'hand') {
      gesture = { type: 'pan', clientX: event.clientX, clientY: event.clientY, x: doc.viewport.x, y: doc.viewport.y };
      stage.style.cursor = 'grabbing';
    } else if (isShape(tool)) {
      if (doc.elements.length >= 5000) { toast('オブジェクト数の上限です。'); return; }
      const shape = M.createItem(tool, { x: p.x, y: p.y, text: 'テキスト' });
      doc.elements.push(shape); selected = new Set([shape.id]);
      gesture = { type: 'shape', id: shape.id, start: p, dragged: false };
    } else if (tool === 'note' || tool === 'text') {
      addItem(tool, p, tool === 'note' ? { text: 'アイデアを書く' } : { text: 'テキスト' }, true); return;
    } else if (tool === 'arrow') {
      if (doc.elements.length >= 5000) { toast('オブジェクト数の上限です。'); return; }
      const arrow = M.createItem('arrow', { from: endpoint(p), to: { ...p } });
      doc.elements.push(arrow); selected = new Set([arrow.id]);
      gesture = { type: 'arrow', id: arrow.id, start: p, created: true };
    } else if (handle?.startsWith('branch-')) {
      event.preventDefault(); addBranch(handle.slice(7)); return;
    } else if (handle) {
      const el = getElement(event.target.getAttribute('data-id'));
      gesture = { type: handle === 'resize' ? 'resize' : 'endpoint', end: handle, id: el.id, start: p, original: M.clone(el) };
    } else if (id) {
      if (event.shiftKey) { if (selected.has(id)) selected.delete(id); else selected.add(id); }
      else if (!selected.has(id)) selected = new Set([id]);
      gesture = { type: 'move', start: p, originals: doc.elements.filter(el => selected.has(el.id)).map(el => ({ ...M.clone(el), ...(el.type === 'arrow' ? { visibleEnds: M.arrowEndpoints(el, doc.elements) } : {}) })), moved: false };
    } else {
      if (!event.shiftKey) selected.clear();
      gesture = { type: 'marquee', start: p, current: p, initial: new Set(selected) };
    }
    event.preventDefault(); canvas.setPointerCapture(event.pointerId); render(); updateUI();
  });
  canvas.addEventListener('pointermove', event => {
    const p = point(event); lastPointer = p;
    if (!gesture) return;
    const g = gesture;
    if (g.type === 'pan') { doc.viewport.x = g.x + event.clientX - g.clientX; doc.viewport.y = g.y + event.clientY - g.clientY; }
    if (g.type === 'move') {
      const dx = p.x - g.start.x, dy = p.y - g.start.y;
      if (Math.hypot(dx, dy) * doc.viewport.zoom > 2) g.moved = true;
      if (g.moved) for (const original of g.originals) {
        const el = getElement(original.id); if (!el) continue;
        if (el.type === 'arrow') {
          for (const end of ['from', 'to']) {
            const base = original[end].elementId && !selected.has(original[end].elementId) ? original.visibleEnds[end] : original[end];
            el[end] = { ...base, x: base.x + dx, y: base.y + dy };
          }
        } else { el.x = original.x + dx; el.y = original.y + dy; }
      }
    }
    if (g.type === 'shape') {
      const el = getElement(g.id), dx = p.x - g.start.x, dy = p.y - g.start.y;
      if (Math.hypot(dx, dy) * doc.viewport.zoom > 5) g.dragged = true;
      if (g.dragged) { el.x = Math.min(p.x, g.start.x); el.y = Math.min(p.y, g.start.y); el.width = Math.max(100, Math.abs(dx)); el.height = Math.max(70, Math.abs(dy)); }
    }
    if (g.type === 'resize') {
      const el = getElement(g.id), original = g.original;
      el.width = Math.max(el.type === 'text' ? 70 : 100, original.width + p.x - g.start.x);
      el.height = ['image', 'diagram'].includes(el.type) ? el.width * original.height / original.width : Math.max(60, original.height + p.y - g.start.y);
      if (hasText(el)) {
        const manualHeight = el.height; fitTextHeight(el); el.height = Math.max(manualHeight, el.height);
      }
    }
    if (g.type === 'arrow') { const el = getElement(g.id); el.to = endpoint(p, el.from.elementId); }
    if (g.type === 'endpoint') { const el = getElement(g.id); el[g.end] = endpoint(p, el[g.end === 'from' ? 'to' : 'from'].elementId); }
    if (g.type === 'marquee') {
      g.current = p;
      const left = Math.min(g.start.x, p.x), top = Math.min(g.start.y, p.y), right = Math.max(g.start.x, p.x), bottom = Math.max(g.start.y, p.y);
      selected = new Set(g.initial);
      for (const el of doc.elements) {
        const ends = el.type === 'arrow' ? M.arrowEndpoints(el, doc.elements) : null;
        const b = ends ? { x: Math.min(ends.from.x, ends.to.x), y: Math.min(ends.from.y, ends.to.y), width: Math.abs(ends.to.x - ends.from.x), height: Math.abs(ends.to.y - ends.from.y) } : M.getBounds([el]);
        if (b && b.x >= left && b.y >= top && b.x + b.width <= right && b.y + b.height <= bottom) selected.add(el.id);
      }
    }
    render();
  });
  function endGesture(event, cancelled = false) {
    if (!gesture) return;
    const g = gesture; gesture = null;
    if (g.type === 'shape') {
      if (cancelled) { doc.elements = doc.elements.filter(x => x.id !== g.id); selected.clear(); }
      else { const el = getElement(g.id); fitTextHeight(el); setTool('select'); commit(); editText(el, true); }
    }
    if (g.type === 'arrow') {
      const el = getElement(g.id), ends = M.arrowEndpoints(el, doc.elements);
      if (cancelled || Math.hypot(ends.to.x - ends.from.x, ends.to.y - ends.from.y) < 8) {
        doc.elements = doc.elements.filter(x => x.id !== g.id); selected.clear();
        if (!cancelled) toast('始点から終点までドラッグすると矢印を引けます。');
      } else setTool('select');
    } else if (cancelled && g.original) Object.assign(getElement(g.id), g.original);
    else if (cancelled && g.originals) g.originals.forEach(original => { const { visibleEnds, ...clean } = original; Object.assign(getElement(original.id), clean); });
    if (!['pan', 'marquee', 'shape'].includes(g.type)) commit();
    else { updateUI(); render(); scheduleAutosave(); }
    stage.style.cursor = spacePressed || tool === 'hand' ? 'grab' : tool === 'arrow' ? 'crosshair' : 'default';
    if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    // SVG nodes are regenerated on selection; use stable pointer positions for double clicks.
    if (!cancelled && event && tool === 'select' && ((g.type === 'move' && !g.moved) || (g.type === 'marquee' && Math.hypot(g.current.x - g.start.x, g.current.y - g.start.y) < 3))) {
      const p = point(event), selectedArrow = g.type === 'move' && g.originals.length === 1 && g.originals[0].type === 'arrow' ? getElement(g.originals[0].id) : null, hit = selectedArrow || boxAt(p), now = performance.now();
      if (lastTap && now - lastTap.time < 450 && lastTap.id === (hit?.id || null) && Math.hypot(lastTap.x - event.clientX, lastTap.y - event.clientY) < 6) {
        lastTap = null;
        if (hit) editElement(hit);
        else addItem('note', p, { text: 'アイデアを書く' }, true);
      } else lastTap = { id: hit?.id || null, time: now, x: event.clientX, y: event.clientY };
    } else lastTap = null;
  }
  canvas.addEventListener('pointerup', event => endGesture(event));
  canvas.addEventListener('pointercancel', event => endGesture(event, true));
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  function zoomAt(nextZoom, screen = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }) {
    const old = doc.viewport.zoom, zoom = Math.max(.2, Math.min(3, nextZoom));
    doc.viewport.x = screen.x - (screen.x - doc.viewport.x) * zoom / old;
    doc.viewport.y = screen.y - (screen.y - doc.viewport.y) * zoom / old;
    doc.viewport.zoom = zoom; render(); scheduleAutosave();
  }
  stage.addEventListener('wheel', event => {
    if (event.target !== canvas && !canvas.contains(event.target)) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = stage.getBoundingClientRect(); zoomAt(doc.viewport.zoom * Math.exp(-event.deltaY * .01), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else {
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      doc.viewport.x -= event.deltaX * multiplier; doc.viewport.y -= event.deltaY * multiplier; render(); scheduleAutosave();
    }
  }, { passive: false });
  function fitAll() {
    finishEdit();
    if (!doc.elements.length) { doc.viewport = { x: 0, y: 0, zoom: 1 }; render(); return; }
    const b = M.getBounds(doc.elements), padding = 100;
    const zoom = Math.max(.2, Math.min(1.4, (stage.clientWidth - padding * 2) / Math.max(b.width, 1), (stage.clientHeight - padding * 2) / Math.max(b.height, 1)));
    doc.viewport = { zoom, x: stage.clientWidth / 2 - (b.x + b.width / 2) * zoom, y: stage.clientHeight / 2 - (b.y + b.height / 2) * zoom };
    render(); scheduleAutosave();
  }
  function setSelectValue(id, value, label) {
    const select = $(id); select.querySelectorAll('option[data-custom]').forEach(option => option.remove());
    if (![...select.options].some(option => option.value === String(value))) { const option = document.createElement('option'); option.value = String(value); option.textContent = label; option.dataset.custom = 'true'; select.append(option); }
    select.value = String(value);
  }
  function updateInspector() {
    const elements = doc.elements.filter(el => selected.has(el.id));
    $('selection-panel').hidden = elements.length === 0 || !!editing;
    if (!elements.length) return;
    const one = elements.length === 1 ? elements[0] : null;
    $('selection-kind').textContent = one ? ({ rect: '四角', ellipse: '丸', diamond: 'ひし形', note: '付箋', text: 'テキスト', image: '画像', diagram: 'Mermaid図', arrow: '矢印' })[one.type] : `${elements.length} 個を選択`;
    $('colors').replaceChildren();
    const palette = palettes[one?.type];
    $('colors').hidden = !palette; $('colors').closest('.panel-field').hidden = !palette;
    if (palette) for (const color of palette) {
      const button = document.createElement('button'); button.className = 'color-swatch';
      button.style.setProperty('--swatch', color); button.style.backgroundColor = color;
      button.title = `色 ${color}`; button.setAttribute('aria-label', `色を${color}に変更`);
      button.classList.toggle('active', one.color === color);
      button.addEventListener('click', () => { one.color = color; commit(); }); $('colors').append(button);
    }
    $('font-size').hidden = !one || !hasText(one); $('font-size').closest('.font-field').hidden = $('font-size').hidden;
    if (one && hasText(one)) setSelectValue('font-size', one.fontSize, `${one.fontSize} px`);
    $('image-caption').hidden = one?.type !== 'image';
    $('diagram-edit').hidden = one?.type !== 'diagram';
    $('branch-controls').hidden = !one || !(isShape(one) || one.type === 'note');
    const boxes = elements.filter(el => el.type !== 'arrow');
    $('alignment-controls').hidden = boxes.length < 2;
    document.querySelectorAll('[data-align^="distribute"]').forEach(button => { button.disabled = boxes.length < 3; });
    $('arrow-controls').hidden = one?.type !== 'arrow';
    if (one?.type === 'arrow') {
      const field = $('arrow-label'); field.dataset.elementId = one.id;
      if (document.activeElement !== field) field.value = one.label || '';
      $('arrow-line-style').value = one.lineStyle || 'solid';
      $('arrow-head').value = one.head || 'end';
      setSelectValue('arrow-width', one.strokeWidth, `${one.strokeWidth} px`);
    }
  }
  function elementBounds(el) {
    if (el.type !== 'arrow') return M.getBounds([el]);
    const ends = M.arrowEndpoints(el, doc.elements);
    return M.getBounds([{ ...el, from: ends.from, to: ends.to }]);
  }
  function revealElement(el, centerOn = false) {
    const b = elementBounds(el), v = doc.viewport;
    const rightPanel = stage.clientWidth > 760 ? 250 : 30;
    const left = 45, top = 120, right = Math.max(left + 160, stage.clientWidth - rightPanel), bottom = Math.max(top + 100, stage.clientHeight - 70);
    if (centerOn) {
      v.zoom = Math.max(.2, Math.min(v.zoom, (right - left) / Math.max(b.width + 40, 1), (bottom - top) / Math.max(b.height + 40, 1)));
      v.x = (left + right) / 2 - (b.x + b.width / 2) * v.zoom;
      v.y = (top + bottom) / 2 - (b.y + b.height / 2) * v.zoom;
    } else {
      const x1 = v.x + b.x * v.zoom, x2 = x1 + b.width * v.zoom;
      const y1 = v.y + b.y * v.zoom, y2 = y1 + b.height * v.zoom;
      if (x2 > right) v.x -= x2 - right;
      else if (x1 < left) v.x += left - x1;
      if (y2 > bottom) v.y -= y2 - bottom;
      else if (y1 < top) v.y += top - y1;
    }
    scheduleAutosave();
  }
  function addBranch(direction = 'right') {
    finishEdit();
    if (selected.size !== 1) return;
    if (doc.elements.length + 2 > M.LIMITS.elements) { toast('オブジェクト数の上限です。'); return; }
    try {
      const source = getElement([...selected][0]);
      if (!source || !(isShape(source) || source.type === 'note')) return;
      const draft = M.createItem(source.type, { width: source.width, height: source.height, fontSize: source.fontSize, text: '新しいアイデア' });
      fitTextHeight(draft);
      const additions = F.branchElements(doc.elements, source.id, direction, { width: draft.width, height: draft.height });
      if (!additions.length) return;
      const node = additions.find(el => el.type !== 'arrow');
      doc.elements.push(...additions); selected = new Set([node.id]);
      fitTextHeight(node); revealElement(node); setTool('select'); commit(); editText(node, true);
    } catch (error) { toast(`図形を追加できません: ${error.message}`); }
  }
  function alignSelection(mode) {
    finishEdit();
    doc.elements = F.alignElements(doc.elements, [...selected], mode);
    commit(); stage.focus({ preventScroll: true });
  }
  function editElement(el) {
    if (el?.type === 'arrow') {
      selected = new Set([el.id]); updateUI(); render();
      $('arrow-label').focus(); $('arrow-label').select();
    } else if (el?.type === 'diagram') {
      window.BrainstormorDiagramEditor.openBoard(el.source, el.name, ({ source, name, diagramType, svg: renderedSvg }) => {
        const current = getElement(el.id);
        if (!current) { toast('編集する図が見つかりません。'); return false; }
        current.source = source; current.name = name; current.diagramType = diagramType;
        diagramPreviews.set(current.id, diagramPreview(current, { svg: renderedSvg }));
        commit(); toast('ボードのMermaid図を更新しました。'); return true;
      });
    } else editText(el);
  }
  function updateSearch() {
    if ($('search-panel').hidden) return;
    const activeId = searchMatches[searchIndex];
    searchMatches = F.searchElements(doc.elements, $('search-input').value);
    searchIndex = searchMatches.length ? Math.max(0, searchMatches.indexOf(activeId)) : -1;
    $('search-count').textContent = $('search-input').value.trim() ? (searchMatches.length ? `${searchIndex + 1} / ${searchMatches.length}` : '見つかりません') : '文字を入力';
    $('search-prev').disabled = $('search-next').disabled = searchMatches.length === 0;
  }
  function focusSearchResult(step = 0) {
    updateSearch();
    if (!searchMatches.length) { render(); return; }
    searchIndex = (searchIndex + step + searchMatches.length) % searchMatches.length;
    const el = getElement(searchMatches[searchIndex]);
    selected = new Set([el.id]); revealElement(el, true);
    updateUI(); render();
  }
  function openSearch() {
    finishEdit(); $('search-panel').hidden = false; updateSearch(); render();
    $('search-input').focus(); $('search-input').select();
  }
  function closeSearch(focusCanvas = true) {
    $('search-panel').hidden = true; $('search-input').value = '';
    searchMatches = []; searchIndex = -1;
    if (focusCanvas) stage.focus({ preventScroll: true });
    render();
  }
  function openTemplates() { finishEdit(); $('templates-dialog').showModal(); }
  async function useTemplate(id) {
    finishEdit(); if (!(await confirmReplace())) return;
    try {
      const template = F.createTemplate(id);
      closeSearch(false); doc = template; selected.clear(); savedSnapshot = ''; localSaved = false;
      resetHistory(); revision++; setTool('select'); $('templates-dialog').close();
      fitAll(); updateUI(); render(); autosave(); toast('テンプレートを開きました。文字は自由に書き換えられます。');
      stage.focus({ preventScroll: true });
    } catch (error) { toast(`テンプレートを開けません: ${error.message}`); }
  }
  function initializeFeatures() {
    const icons = {
      mindmap: '<path d="M50 42V22H22m28 0h28M50 42v20H22m28 0h28"/><rect x="35" y="33" width="30" height="18" rx="4"/><rect x="7" y="14" width="25" height="16" rx="4"/><rect x="68" y="14" width="25" height="16" rx="4"/><rect x="7" y="54" width="25" height="16" rx="4"/><rect x="68" y="54" width="25" height="16" rx="4"/>',
      flow: '<rect x="8" y="30" width="24" height="22" rx="4"/><path d="M32 41h9m21 0h10M52 24l15 17-15 17-15-17z"/><rect x="72" y="30" width="23" height="22" rx="4"/>',
      retro: '<rect x="6" y="13" width="26" height="54" rx="4"/><rect x="37" y="13" width="26" height="54" rx="4"/><rect x="68" y="13" width="26" height="54" rx="4"/><path d="M12 26h14m17 0h14m17 0h14M12 37h14m17 0h14m17 0h14M12 48h10m21 0h10m21 0h10"/>',
    };
    for (const template of F.templates) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'template-card'; button.dataset.template = template.id;
      button.setAttribute('aria-label', `${template.title}をボードで開く`);
      const preview = document.createElement('span'); preview.className = `template-preview template-${template.kind}`;
      // These diagrams are static application geometry, never imported file content.
      preview.innerHTML = `<svg viewBox="0 0 100 82" fill="none" aria-hidden="true">${icons[template.kind] || icons.flow}</svg>`;
      const title = document.createElement('span'); title.className = 'template-title'; title.textContent = template.title;
      const description = document.createElement('span'); description.className = 'template-description'; description.textContent = template.description;
      const openLabel = document.createElement('span'); openLabel.className = 'template-open-label'; openLabel.textContent = 'ボードで開く →';
      button.append(preview, title, description, openLabel); button.addEventListener('click', () => useTemplate(template.id));
      $('template-list').append(button);
    }
    const diagramIcons = {
      sequence: '<rect x="8" y="7" width="24" height="15" rx="3"/><rect x="68" y="7" width="24" height="15" rx="3"/><path d="M20 24v49m60-49v49" stroke-dasharray="3 4"/><path d="M20 36h60l-6-5m6 5-6 5M80 58H20l6-5m-6 5 6 5"/>',
      flowchart: icons.flow,
      class: '<rect x="8" y="10" width="36" height="55" rx="3"/><rect x="59" y="27" width="33" height="38" rx="3"/><path d="M8 27h36M8 44h36m15 0h33M44 37h15M15 19h22M15 35h17M15 53h19M66 36h19M66 53h17"/>',
      er: '<rect x="5" y="20" width="32" height="42" rx="3"/><rect x="63" y="20" width="32" height="42" rx="3"/><path d="M5 34h32m26 0h32M37 43h26M42 37v12m15-6 6-6m-6 6 6 6"/>',
      state: '<circle cx="14" cy="41" r="5"/><rect x="33" y="27" width="35" height="28" rx="8"/><circle cx="88" cy="41" r="7"/><circle cx="88" cy="41" r="3"/><path d="M19 41h14m35 0h13"/>',
      gantt: '<path d="M18 12v57h76M18 28h76m-76 18h76M42 12v57m25-57v57" stroke-opacity=".3"/><rect x="20" y="16" width="30" height="8" rx="2"/><rect x="42" y="34" width="37" height="8" rx="2"/><rect x="63" y="52" width="29" height="8" rx="2"/>',
      mindmap: icons.mindmap,
      pie: '<path d="M50 41V12a29 29 0 0 1 29 29zM45 18a28 28 0 1 0 33 29H45z"/>',
    };
    for (const template of window.BrainstormorMermaidTemplates.templates) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'diagram-template-card'; card.dataset.diagramTemplate = template.id;
      const preview = document.createElement('span'); preview.className = 'diagram-template-preview';
      preview.innerHTML = `<svg viewBox="0 0 100 82" aria-hidden="true">${diagramIcons[template.id]}</svg>`;
      const title = document.createElement('strong'); title.textContent = template.title;
      const description = document.createElement('small'); description.textContent = template.description;
      card.append(preview, title, description);
      card.addEventListener('click', async () => {
        $('templates-dialog').close();
        try {
          if (await openDiagramBoard(template.source, template.id, template.title)) toast('Mermaid図をボードに置きました。ダブルクリックで編集できます。');
        } catch (error) { toast(`図を開けません: ${error.message}`); }
      });
      $('diagram-template-list').append(card);
    }
    document.querySelectorAll('[data-template-group]').forEach(button => button.addEventListener('click', () => {
      const group = button.dataset.templateGroup;
      $('mermaid-template-section').hidden = group !== 'mermaid'; $('board-template-section').hidden = group !== 'board';
      document.querySelectorAll('[data-template-group]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
    }));
    $('templates-btn').addEventListener('click', openTemplates);
    $('empty-templates')?.addEventListener('click', openTemplates);
    $('close-templates').addEventListener('click', () => $('templates-dialog').close());
    document.querySelectorAll('[data-branch]').forEach(button => button.addEventListener('click', () => addBranch(button.dataset.branch)));
    document.querySelectorAll('[data-align]').forEach(button => button.addEventListener('click', () => alignSelection(button.dataset.align)));
    $('search-btn').addEventListener('click', openSearch);
    $('close-search').addEventListener('click', () => closeSearch());
    $('search-input').addEventListener('input', () => { searchIndex = -1; focusSearchResult(); });
    $('search-input').addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); focusSearchResult(event.shiftKey ? -1 : 1); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); }
    });
    $('search-prev').addEventListener('click', () => focusSearchResult(-1));
    $('search-next').addEventListener('click', () => focusSearchResult(1));
    $('arrow-label').addEventListener('input', event => {
      const el = getElement(event.target.dataset.elementId); if (el?.type !== 'arrow') return;
      el.label = event.target.value; revision++; localSaved = false; scheduleAutosave(); status(); updateSearch(); render();
    });
    $('arrow-label').addEventListener('blur', () => commit());
    $('arrow-label').addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.target.blur(); stage.focus({ preventScroll: true }); }
    });
    for (const [id, property] of [['arrow-line-style', 'lineStyle'], ['arrow-head', 'head'], ['arrow-width', 'strokeWidth']]) {
      $(id).addEventListener('change', event => {
        const el = getElement([...selected][0]); if (el?.type !== 'arrow') return;
        el[property] = property === 'strokeWidth' ? Number(event.target.value) : event.target.value; commit();
      });
    }
  }
  let mermaidMode = 'import', mermaidResult = null, mermaidTimer, mermaidFileName = '';
  const mermaidExample = 'flowchart LR\n  A["アイデアを出す"] --> B{"すぐ試せる？"}\n  B -->|はい| C["小さく試す"]\n  B -->|いいえ| D["もっと小さく分ける"]\n  D -.-> A';
  function mermaidMessage(messages, error = false) {
    const message = $('mermaid-message');
    message.textContent = Array.isArray(messages) ? messages.join('\n') : messages;
    message.hidden = !message.textContent; message.classList.toggle('is-error', error);
  }
  function validateMermaid() {
    clearTimeout(mermaidTimer); mermaidResult = null; $('mermaid-load').disabled = true;
    if (mermaidMode !== 'import') return;
    const diagramType = window.BrainstormorDiagramEditor.detectType($('mermaid-code').value);
    $('mermaid-load').textContent = 'ボードで開く';
    if (diagramType && diagramType !== 'flowchart') {
      mermaidResult = { diagramType, source: $('mermaid-code').value };
      $('mermaid-summary').textContent = window.BrainstormorMermaidTemplates.getTemplate(diagramType).title;
      mermaidMessage('Mermaidコードを保った図としてボードに置きます。'); $('mermaid-load').disabled = false; return;
    }
    try {
      mermaidResult = window.BrainstormorMermaid.importFlowchart($('mermaid-code').value);
      const nodes = mermaidResult.document.elements.filter(el => el.type !== 'arrow').length;
      const arrows = mermaidResult.document.elements.length - nodes;
      $('mermaid-summary').textContent = `${nodes}個の図形 · ${arrows}本の矢印`;
      mermaidMessage(mermaidResult.warnings); $('mermaid-load').disabled = false;
    } catch (error) {
      if (diagramType === 'flowchart') {
        mermaidResult = { diagramType, source: $('mermaid-code').value };
        $('mermaid-summary').textContent = 'フローチャートをMermaid図として配置';
        mermaidMessage('図形への変換に対応しない構文です。Mermaid図として描画できるか、ボードで開くときに確認します。');
        $('mermaid-load').disabled = false;
      } else { $('mermaid-summary').textContent = ''; mermaidMessage(error.message, true); }
    }
  }
  function generateMermaid() {
    try {
      const diagrams = doc.elements.filter(el => el.type === 'diagram');
      const selectedDiagram = selected.size === 1 ? diagrams.find(el => selected.has(el.id)) : null;
      const diagram = selectedDiagram || (doc.elements.length === 1 ? diagrams[0] : null);
      const result = diagram
        ? { source: diagram.source, warnings: ['ボード上のMermaid図のコードです。'] }
        : window.BrainstormorMermaid.exportFlowchart(doc, $('mermaid-direction').value);
      $('mermaid-code').value = result.source; mermaidMessage(result.warnings);
      $('mermaid-summary').textContent = `${result.source.split('\n').length}行`;
      $('mermaid-download').disabled = $('mermaid-copy').disabled = false;
    } catch (error) {
      $('mermaid-code').value = ''; mermaidMessage(error.message, true);
      $('mermaid-summary').textContent = ''; $('mermaid-download').disabled = $('mermaid-copy').disabled = true;
    }
  }
  function setMermaidMode(mode, source) {
    clearTimeout(mermaidTimer); mermaidMode = mode;
    const importing = mode === 'import';
    document.querySelectorAll('[data-mermaid-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mermaidMode === mode)));
    $('mermaid-code').readOnly = !importing;
    $('mermaid-choose-file').hidden = !importing; $('mermaid-load').hidden = !importing;
    $('mermaid-direction-field').hidden = importing || (selected.size === 1 && doc.elements.some(el => el.type === 'diagram' && selected.has(el.id))) || (doc.elements.length === 1 && doc.elements[0].type === 'diagram');
    $('mermaid-copy').hidden = importing; $('mermaid-download').hidden = importing;
    $('mermaid-hint').textContent = importing
      ? 'Mermaidコードを貼り付けてボードで開きます。基本的なフローチャートは図形に変換します。'
      : 'いまのボードをMermaidコードに変換しました。コピーやファイル保存で持ち出せます。';
    if (importing) { $('mermaid-code').value = source ?? mermaidDraft; validateMermaid(); }
    else generateMermaid();
  }
  let mermaidDraft = mermaidExample;
  function openMermaid(mode = 'import', source, name = '') {
    finishEdit(); if (gesture) endGesture(null, true);
    if (source !== undefined) { mermaidDraft = source; mermaidFileName = name; }
    setMermaidMode(mode, source); $('mermaid-dialog').showModal();
    if (mode === 'import') $('mermaid-code').focus();
  }
  async function readMermaidFile(file) {
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('Mermaidファイルは1MB以下にしてください。');
      const source = await file.text();
      if (source.length > M.LIMITS.diagramSource) throw new Error('Mermaidコードは50,000文字以内にしてください。');
      mermaidDraft = source; mermaidFileName = file.name.replace(/\.[^.]+$/, '');
      if ($('mermaid-dialog').open) setMermaidMode('import', source);
      else openMermaid('import', source, mermaidFileName);
    } catch (error) { if ($('mermaid-dialog').open) mermaidMessage(error.message, true); else toast(error.message); }
  }
  async function openDiagramBoard(source, diagramType, title, stillCurrent = () => true) {
    if (source.length > M.LIMITS.diagramSource) throw new Error('Mermaidコードは50,000文字以内にしてください。');
    const rendered = await window.BrainstormorMermaidRenderer.render(source);
    if (!stillCurrent() || !(await confirmReplace())) return false;
    const loaded = M.createDocument(title);
    const diagram = M.createItem('diagram', { source, diagramType, name: title });
    const preview = diagramPreview(diagram, rendered);
    diagram.width = preview.width; diagram.height = preview.height;
    loaded.elements.push(diagram); diagramPreviews.set(diagram.id, preview);
    closeSearch(false); doc = loaded; selected = new Set([diagram.id]); savedSnapshot = ''; localSaved = false;
    resetHistory(); revision++; setTool('select'); if ($('mermaid-dialog').open) $('mermaid-dialog').close(); fitAll(); updateUI(); render(); autosave();
    stage.focus({ preventScroll: true });
    return true;
  }
  async function loadMermaidBoard() {
    validateMermaid(); if (!mermaidResult) return;
    if (mermaidResult.diagramType) {
      const { diagramType, source } = mermaidResult;
      $('mermaid-load').disabled = true; mermaidMessage('Mermaid図を描画しています…');
      try {
        const title = mermaidFileName || window.BrainstormorMermaidTemplates.getTemplate(diagramType).title;
        if (await openDiagramBoard(source, diagramType, title, () => $('mermaid-code').value === source)) toast('Mermaid図をボードで開きました。ダブルクリックで編集できます。');
      } catch (error) { mermaidMessage(`Mermaid図を開けません: ${error.message}`, true); }
      finally { $('mermaid-load').disabled = false; }
      return;
    }
    if (!(await confirmReplace())) return;
    const loaded = M.clone(mermaidResult.document);
    if (mermaidFileName) loaded.title = mermaidFileName;
    closeSearch(false); doc = loaded; selected.clear(); savedSnapshot = ''; localSaved = false;
    resetHistory(); revision++; setTool('select'); $('mermaid-dialog').close(); fitAll(); updateUI(); render(); autosave();
    toast('Mermaidを図形に変換しました。ダブルクリックで文字を編集できます。'); stage.focus({ preventScroll: true });
  }
  function initializeMermaid() {
    $('mermaid-btn').addEventListener('click', () => openMermaid());
    $('mermaid-new-diagram').addEventListener('click', () => { $('mermaid-dialog').close(); openTemplates(); });
    $('export-mermaid').addEventListener('click', () => { $('export-dialog').close(); openMermaid('export'); });
    $('close-mermaid').addEventListener('click', () => $('mermaid-dialog').close());
    document.querySelectorAll('[data-mermaid-mode]').forEach(button => button.addEventListener('click', () => {
      if (mermaidMode === 'import') mermaidDraft = $('mermaid-code').value;
      setMermaidMode(button.dataset.mermaidMode);
    }));
    $('mermaid-code').addEventListener('input', () => {
      if (mermaidMode !== 'import') return;
      mermaidDraft = $('mermaid-code').value; mermaidFileName = ''; mermaidResult = null; $('mermaid-load').disabled = true;
      clearTimeout(mermaidTimer); mermaidTimer = setTimeout(validateMermaid, 180);
    });
    $('mermaid-direction').addEventListener('change', generateMermaid);
    $('mermaid-choose-file').addEventListener('click', () => $('mermaid-file-input').click());
    $('mermaid-file-input').addEventListener('change', event => { readMermaidFile(event.target.files[0]); event.target.value = ''; });
    $('mermaid-load').addEventListener('click', loadMermaidBoard);
    $('mermaid-download').addEventListener('click', () => {
      download(new Blob([$('mermaid-code').value], { type: 'text/plain;charset=utf-8' }), filename('.mmd'));
      toast('Mermaidファイルを書き出しました。');
    });
    $('mermaid-copy').addEventListener('click', async () => {
      const code = $('mermaid-code');
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code.value);
        else { code.focus(); code.select(); if (!document.execCommand('copy')) throw new Error('copy'); }
        toast('Mermaidコードをコピーしました。');
      } catch { code.focus(); code.select(); mermaidMessage('コードを選択しました。⌘ / Ctrl + C でコピーしてください。'); }
    });
  }
  function removeSelected() {
    finishEdit(); if (!selected.size) return;
    // Freeze connected endpoints at their visible position before deleting their targets.
    for (const el of doc.elements) if (el.type === 'arrow') {
      const ends = M.arrowEndpoints(el, doc.elements);
      for (const end of ['from', 'to']) if (selected.has(el[end].elementId)) el[end] = ends[end];
    }
    doc.elements = doc.elements.filter(el => !selected.has(el.id)); selected.clear(); commit();
  }
  function copySelection(elements) {
    const ids = new Set(elements.map(el => el.id));
    return elements.map(original => {
      const copy = M.clone(original);
      if (original.type === 'arrow') {
        const ends = M.arrowEndpoints(original, doc.elements);
        for (const end of ['from', 'to']) if (!ids.has(original[end].elementId)) copy[end] = ends[end];
      }
      return copy;
    });
  }
  function duplicate(elements = copySelection(doc.elements.filter(el => selected.has(el.id))), offset = 28) {
    finishEdit(); if (!elements.length) return;
    if (doc.elements.length + elements.length > 5000) { toast('オブジェクト数の上限です。'); return; }
    const idMap = new Map();
    const copies = elements.map(el => { const copy = M.createItem(el.type, M.clone(el)); copy.id = M.createItem(el.type).id; idMap.set(el.id, copy.id); return copy; });
    for (const copy of copies) {
      copy.x += offset; copy.y += offset;
      if (copy.type === 'arrow') for (const end of ['from', 'to']) {
        copy[end].x += offset; copy[end].y += offset;
        if (idMap.has(copy[end].elementId)) copy[end].elementId = idMap.get(copy[end].elementId);
        else delete copy[end].elementId;
      }
    }
    doc.elements.push(...copies); selected = new Set(copies.map(x => x.id)); commit();
  }
  function moveLayer(front) {
    finishEdit(); const group = doc.elements.filter(el => selected.has(el.id)), rest = doc.elements.filter(el => !selected.has(el.id));
    doc.elements = front ? [...rest, ...group] : [...group, ...rest]; commit();
  }
  async function addImages(files, at = center()) {
    finishEdit(); let count = 0;
    const startedDocument = doc;
    for (const file of files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { toast('PNG・JPEG・WebP・GIFの画像を選んでください。'); continue; }
      if (file.size > 12 * 1024 * 1024) { toast('画像は1枚12MBまでです。小さくしてから追加してください。'); continue; }
      try {
        const src = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        const image = await loadImage(src);
        if (doc !== startedDocument) return;
        if (new Blob([M.serialize(doc)]).size + src.length > MAX_BYTES - 10000) { toast('ボードは40MBまでです。画像を小さくするか、別のボードに分けてください。'); break; }
        const scale = Math.min(1, 560 / image.width, 440 / image.height);
        const width = Math.max(24, image.width * scale), height = Math.max(24, image.height * scale);
        addItem('image', { x: at.x - width / 2 + count * 24, y: at.y - height / 2 + count * 24 }, { src, width, height, name: file.name || '貼り付けた画像' }); count++;
      } catch { toast('この画像を読み込めませんでした。別の形式で試してください。'); }
    }
    if (count) toast(`${count}枚の画像を追加しました。「文字をのせる」で注釈を付けられます。`);
  }
  function loadImage(src) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; }); }
  $('image-input').addEventListener('change', event => { addImages([...event.target.files]); event.target.value = ''; });
  stage.addEventListener('dragenter', event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth++; $('drop-overlay').hidden = false; } });
  stage.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  stage.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
  stage.addEventListener('drop', async event => {
    event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
    const files = [...event.dataTransfer.files], board = files.find(file => /\.(brainstorm|json|mmd|mermaid)$/i.test(file.name));
    if (board) await openFile(board); else await addImages(files, point(event));
  });
  const isTyping = target => target instanceof Element && (target.matches('input,textarea,select') || target.isContentEditable);
  document.addEventListener('copy', event => {
    if (isTyping(event.target) || document.querySelector('dialog[open]') || !selected.size) return;
    clipboardElements = copySelection(doc.elements.filter(el => selected.has(el.id)));
    event.clipboardData.setData('application/x-brainstormor', 'selection');
    event.clipboardData.setData('text/plain', clipboardElements.filter(el => el.text).map(el => el.text).join('\n'));
    event.preventDefault();
  });
  document.addEventListener('paste', event => {
    if (restoring || isTyping(event.target) || document.querySelector('dialog[open]')) return;
    const data = event.clipboardData;
    const files = [...data.files].filter(file => file.type.startsWith('image/'));
    if (files.length) { event.preventDefault(); addImages(files); return; }
    if (data.types.includes('application/x-brainstormor') && clipboardElements) { event.preventDefault(); duplicate(clipboardElements); return; }
    const text = data.getData('text/plain');
    if (text) { event.preventDefault(); const el = addItem('note', center(), { text: text.slice(0, 20000) }); if (el) { fitTextHeight(el); commit(); } }
  });

  function filename(extension, title = doc.title) { return (title.trim() || '無題のボード').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 100) + extension; }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function syncTitle() {
    doc.title = $('board-title').value.trim().slice(0, 160) || '無題のボード';
    $('board-title').value = doc.title;
    commit();
  }
  async function saveFile() {
    if (saving || restoring) return false;
    finishEdit(); syncTitle(); saving = true;
    try {
      const captured = M.clone(doc), serialized = M.serialize(captured);
      download(new Blob([serialized], { type: 'application/json' }), filename('.brainstorm', captured.title));
      savedSnapshot = contentSnapshot(captured); autosave(); status();
      toast('編集できるボードファイルを書き出しました。'); return true;
    } catch (error) { toast(`保存できませんでした: ${error.message}`); return false; }
    finally { saving = false; }
  }
  async function openFile(file) {
    if (/\.(mmd|mermaid)$/i.test(file.name)) { await readMermaidFile(file); return; }
    finishEdit();
    try {
      if (file.size > MAX_BYTES) throw new Error('40MB以下のボードを選んでください。');
      const loaded = M.parse(await file.text());
      if (!(await confirmReplace())) return;
      closeSearch(false); doc = loaded; selected.clear(); savedSnapshot = contentSnapshot();
      resetHistory(); revision++; setTool('select'); updateUI(); render(); autosave(); toast('ボードを開きました。');
    } catch (error) { toast(`ファイルを開けません: ${error.message}`); }
  }
  let replaceResolver = null;
  function confirmReplace() {
    if (!fileDirty() || (!doc.elements.length && doc.title === '無題のボード')) return Promise.resolve(true);
    if (replaceResolver) return Promise.resolve(false);
    return new Promise(resolve => { replaceResolver = resolve; $('replace-dialog').showModal(); });
  }
  function finishReplace(accepted) {
    const resolve = replaceResolver; replaceResolver = null;
    $('replace-dialog').close(); if (resolve) resolve(accepted);
  }
  async function newBoard() {
    finishEdit(); if (!(await confirmReplace())) return;
    closeSearch(false); doc = M.createDocument(); selected.clear(); savedSnapshot = contentSnapshot();
    resetHistory(); revision++; setTool('select'); updateUI(); render(); autosave();
  }
  async function exportSVG() {
    finishEdit();
    if (!doc.elements.length) { toast('図形や付箋を追加してから書き出してください。'); return null; }
    await Promise.all(doc.elements.filter(el => el.type === 'diagram').map(ensureDiagramPreview));
    const b = M.getBounds(doc.elements), padding = 40;
    const width = Math.max(1, Math.ceil(b.width + padding * 2)), height = Math.max(1, Math.ceil(b.height + padding * 2));
    const root = svg('svg', { xmlns: NS, width, height, viewBox: `${b.x - padding} ${b.y - padding} ${width} ${height}` });
    root.append(svg('title', {}, doc.title));
    root.append(svg('rect', { x: b.x - padding, y: b.y - padding, width, height, fill: '#ffffff' }));
    for (const el of doc.elements) root.append(renderElement(el));
    return { source: new XMLSerializer().serializeToString(root), width, height };
  }
  async function exportImage(kind) {
    $('export-dialog').close();
    let result;
    try { result = await exportSVG(); }
    catch (error) { toast(`Mermaid図を描画できません: ${error.message}`); return; }
    if (!result) return;
    const exportTitle = doc.title;
    if (kind === 'svg') { download(new Blob([result.source], { type: 'image/svg+xml' }), filename('.svg')); toast('SVGを書き出しました。'); return; }
    let url;
    try {
      url = URL.createObjectURL(new Blob([result.source], { type: 'image/svg+xml' }));
      const image = await loadImage(url);
      const scale = Math.min(2, 8192 / result.width, 8192 / result.height, Math.sqrt(24000000 / (result.width * result.height)));
      const raster = document.createElement('canvas'); raster.width = Math.max(1, Math.round(result.width * scale)); raster.height = Math.max(1, Math.round(result.height * scale));
      raster.getContext('2d').drawImage(image, 0, 0, raster.width, raster.height);
      const blob = await new Promise(resolve => raster.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNGの作成に失敗しました');
      download(blob, filename('.png', exportTitle)); toast('PNG画像を書き出しました。');
    } catch { toast('PNGを書き出せませんでした。SVGでの書き出しをお試しください。'); }
    finally { if (url) URL.revokeObjectURL(url); }
  }
  document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.tool === 'image') { finishEdit(); $('image-input').click(); }
    else setTool(button.dataset.tool);
  }));
  $('font-size').addEventListener('change', event => { for (const el of doc.elements) if (selected.has(el.id) && hasText(el)) { el.fontSize = Number(event.target.value); fitTextHeight(el); } commit(); });
  $('image-caption').addEventListener('click', () => {
    const image = getElement([...selected][0]); if (!image || image.type !== 'image') return;
    addItem('text', { x: image.x + 12, y: image.y + 12 }, { text: 'ここに注釈を書く', color: '#ffffff', width: Math.max(100, image.width - 24), fontSize: 24 }, true);
  });
  $('diagram-edit').addEventListener('click', () => {
    const diagram = getElement([...selected][0]);
    if (diagram?.type === 'diagram') editElement(diagram);
  });
  $('bring-forward').addEventListener('click', () => moveLayer(true));
  $('send-backward').addEventListener('click', () => moveLayer(false));
  $('duplicate-btn').addEventListener('click', () => duplicate());
  $('delete-btn').addEventListener('click', removeSelected);
  $('undo-btn').addEventListener('click', () => undo()); $('redo-btn').addEventListener('click', () => undo(1));
  $('zoom-in').addEventListener('click', () => zoomAt(doc.viewport.zoom * 1.2));
  $('zoom-out').addEventListener('click', () => zoomAt(doc.viewport.zoom / 1.2));
  $('zoom-label').addEventListener('click', () => zoomAt(1)); $('fit-btn').addEventListener('click', fitAll);
  $('new-board').addEventListener('click', newBoard);
  $('save-board').addEventListener('click', () => saveFile());
  $('open-board').addEventListener('click', () => { finishEdit(); $('file-input').click(); });
  $('file-input').addEventListener('change', event => { const file = event.target.files[0]; if (file) openFile(file); event.target.value = ''; });
  $('export-board').addEventListener('click', () => { finishEdit(); $('export-dialog').showModal(); });
  $('export-svg').addEventListener('click', () => exportImage('svg'));
  $('export-png').addEventListener('click', () => exportImage('png'));
  $('help-btn').addEventListener('click', () => $('help-dialog').showModal());
  $('close-help').addEventListener('click', () => $('help-dialog').close());
  $('close-export').addEventListener('click', () => $('export-dialog').close());
  $('board-title').addEventListener('change', syncTitle);
  $('board-title').addEventListener('blur', syncTitle);
  $('board-title').addEventListener('keydown', event => { if (event.key === 'Enter') { event.target.blur(); stage.focus(); } });
  document.addEventListener('keydown', event => {
    if (document.querySelector('dialog[open]') || restoring) return;
    const mod = event.ctrlKey || event.metaKey;
    if (event.isComposing) return;
    if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); openSearch(); return; }
    if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); if (document.activeElement === $('board-title')) $('board-title').blur(); saveFile(); return; }
    if (isTyping(event.target) || event.isComposing) return;
    const key = event.key.toLowerCase();
    if (gesture && !['shift', 'control', 'meta', 'alt', ' '].includes(key)) endGesture(null, true);
    if (mod && key === 'z') { event.preventDefault(); undo(event.shiftKey ? 1 : -1); }
    else if (mod && key === 'y') { event.preventDefault(); undo(1); }
    else if (mod && key === 'd') { event.preventDefault(); duplicate(); }
    else if (mod && key === 'a') { event.preventDefault(); selected = new Set(doc.elements.map(el => el.id)); updateUI(); render(); }
    else if (mod && key === 'o') { event.preventDefault(); $('file-input').click(); }
    else if (key === 'delete' || key === 'backspace') { event.preventDefault(); removeSelected(); }
    else if (key === 'tab' && !mod && !event.altKey && (event.target === stage || canvas.contains(event.target)) && selected.size === 1 && (isShape(getElement([...selected][0])) || getElement([...selected][0]).type === 'note')) { event.preventDefault(); addBranch(event.shiftKey ? 'down' : 'right'); }
    else if (key === 'escape' && !$('search-panel').hidden) { event.preventDefault(); closeSearch(); }
    else if (key === 'escape') { if (gesture) endGesture(null, true); selected.clear(); setTool('select'); render(); updateUI(); }
    else if (key === ' ') { event.preventDefault(); spacePressed = true; stage.style.cursor = 'grab'; }
    else if (key === 'enter' && selected.size === 1) { event.preventDefault(); editElement(getElement([...selected][0])); }
    else if (!mod && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
      event.preventDefault(); const amount = event.shiftKey ? 10 : 1, dx = key === 'arrowleft' ? -amount : key === 'arrowright' ? amount : 0, dy = key === 'arrowup' ? -amount : key === 'arrowdown' ? amount : 0;
      for (const el of doc.elements.filter(x => selected.has(x.id))) {
        if (el.type === 'arrow') { const ends = M.arrowEndpoints(el, doc.elements); for (const end of ['from', 'to']) { const base = selected.has(el[end].elementId) ? el[end] : ends[end]; el[end] = { ...base, x: base.x + dx, y: base.y + dy }; } }
        else { el.x += dx; el.y += dy; }
      }
      commit();
    } else if (!mod && !event.altKey) {
      const shortcuts = { v: 'select', h: 'hand', r: 'rect', o: 'ellipse', d: 'diamond', n: 'note', t: 'text', a: 'arrow' };
      if (shortcuts[key]) { event.preventDefault(); setTool(shortcuts[key]); }
      else if (key === 'i') { event.preventDefault(); $('image-input').click(); }
      else if (key === 'f') { event.preventDefault(); fitAll(); }
      else if (key === '+' || key === '=') zoomAt(doc.viewport.zoom * 1.2);
      else if (key === '-') zoomAt(doc.viewport.zoom / 1.2);
      else if (key === '?') $('help-dialog').showModal();
    }
  });
  document.addEventListener('keyup', event => { if (event.code === 'Space') { spacePressed = false; stage.style.cursor = tool === 'hand' ? 'grab' : 'default'; } });
  window.addEventListener('blur', () => { spacePressed = false; if (gesture) endGesture(null); });
  window.addEventListener('resize', () => render());
  document.addEventListener('visibilitychange', () => { if (document.hidden) { finishEdit(); autosave(); } });
  window.addEventListener('beforeunload', event => { if (fileDirty() && (!localSaved || autosaveFailed || editing)) { event.preventDefault(); event.returnValue = ''; } });
  async function init() {
    savedSnapshot = contentSnapshot();
    const local = await readLocal();
    if (local?.document) {
      try {
        doc = M.parse(JSON.stringify(local.document));
        savedSnapshot = typeof local.savedSnapshot === 'string' ? local.savedSnapshot : '';
        localSaved = true;
        if (doc.elements.length) toast('前回のボードを復元しました。');
      } catch { toast('前回のデータを復元できませんでした。保存したファイルを開いてください。'); }
    }
    restoring = false; document.querySelector('.app-shell').inert = false; resetHistory(); setTool('select'); updateUI(); render();
  }
  $('replace-cancel').addEventListener('click', () => finishReplace(false));
  $('replace-discard').addEventListener('click', () => finishReplace(true));
  $('replace-save').addEventListener('click', async () => { if (await saveFile()) finishReplace(true); });
  $('replace-dialog').addEventListener('cancel', event => { event.preventDefault(); finishReplace(false); });
  window.BrainstormorDiagramEditor.initialize({ toast });
  initializeFeatures();
  initializeMermaid();
  init();
})();
