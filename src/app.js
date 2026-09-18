(() => {
  'use strict';
  const M = window.BrainstormorModel;
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
    status(); updateInspector();
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
  function renderElement(el) {
    const group = svg('g', { 'data-element-id': el.id, class: `board-element element-${el.type}` });
    if (el.type === 'arrow') {
      const { from, to } = M.arrowEndpoints(el, doc.elements);
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
      const nx = length ? dx / length : 1, ny = length ? dy / length : 0;
      const head = Math.min(16, length / 2), color = el.color || '#526076';
      group.append(svg('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: 'transparent', 'stroke-width': Math.max(18, 18 / doc.viewport.zoom), 'pointer-events': 'stroke' }));
      group.append(svg('line', { x1: from.x, y1: from.y, x2: to.x - nx * head * .6, y2: to.y - ny * head * .6, stroke: color, 'stroke-width': el.strokeWidth || 2.5, 'stroke-linecap': 'round', 'pointer-events': 'none' }));
      group.append(svg('path', { d: `M ${to.x} ${to.y} L ${to.x - nx * head - ny * head * .42} ${to.y - ny * head + nx * head * .42} L ${to.x - nx * head + ny * head * .42} ${to.y - ny * head - nx * head * .42} Z`, fill: color, 'pointer-events': 'none' }));
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
    for (const id of selected) {
      const el = getElement(id); if (!el) continue;
      if (el.type === 'arrow') {
        const endpoints = M.arrowEndpoints(el, doc.elements);
        overlay.append(svg('line', { x1: endpoints.from.x, y1: endpoints.from.y, x2: endpoints.to.x, y2: endpoints.to.y, stroke: '#138776', 'stroke-width': 1 / zoom, 'stroke-dasharray': `${5 / zoom} ${4 / zoom}`, 'pointer-events': 'none' }));
        for (const end of ['from', 'to']) overlay.append(svg('circle', { cx: endpoints[end].x, cy: endpoints[end].y, r: 6 / zoom, fill: 'white', stroke: '#138776', 'stroke-width': 2 / zoom, 'data-handle': end, 'data-id': el.id, cursor: 'crosshair' }));
      } else {
        overlay.append(svg('rect', { x: el.x - 3 / zoom, y: el.y - 3 / zoom, width: el.width + 6 / zoom, height: el.height + 6 / zoom, rx: 6 / zoom, fill: 'none', stroke: '#138776', 'stroke-width': 1.5 / zoom, 'pointer-events': 'none' }));
        if (selected.size === 1) overlay.append(svg('rect', { x: el.x + el.width - 5 / zoom, y: el.y + el.height - 5 / zoom, width: 10 / zoom, height: 10 / zoom, rx: 2 / zoom, fill: 'white', stroke: '#138776', 'stroke-width': 1.5 / zoom, 'data-handle': 'resize', 'data-id': el.id, cursor: 'nwse-resize' }));
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
        const el = getElement(original.id);
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
      el.height = el.type === 'image' ? el.width * original.height / original.width : Math.max(60, original.height + p.y - g.start.y);
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
      const p = point(event), hit = boxAt(p), now = performance.now();
      if (lastTap && now - lastTap.time < 450 && lastTap.id === (hit?.id || null) && Math.hypot(lastTap.x - event.clientX, lastTap.y - event.clientY) < 6) {
        lastTap = null;
        if (hit) editText(hit);
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
  function updateInspector() {
    const elements = doc.elements.filter(el => selected.has(el.id));
    $('selection-panel').hidden = elements.length === 0 || !!editing;
    if (!elements.length) return;
    const one = elements.length === 1 ? elements[0] : null;
    $('selection-kind').textContent = one ? ({ rect: '四角', ellipse: '丸', diamond: 'ひし形', note: '付箋', text: 'テキスト', image: '画像', arrow: '矢印' })[one.type] : `${elements.length} 個を選択`;
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
    if (one && hasText(one)) $('font-size').value = String(one.fontSize);
    $('image-caption').hidden = one?.type !== 'image';
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
    const files = [...event.dataTransfer.files], board = files.find(file => /\.(brainstorm|json)$/i.test(file.name));
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
    if (saving || restoring) return;
    finishEdit(); syncTitle(); saving = true;
    try {
      const captured = M.clone(doc), serialized = M.serialize(captured);
      download(new Blob([serialized], { type: 'application/json' }), filename('.brainstorm', captured.title));
      savedSnapshot = contentSnapshot(captured); autosave(); status();
      toast('編集できるボードファイルを書き出しました。');
    } catch (error) { toast(`保存できませんでした: ${error.message}`); }
    finally { saving = false; }
  }
  async function openFile(file) {
    finishEdit();
    try {
      if (file.size > MAX_BYTES) throw new Error('40MB以下のボードを選んでください。');
      const loaded = M.parse(await file.text());
      if (!confirmReplace()) return;
      doc = loaded; selected.clear(); savedSnapshot = contentSnapshot();
      resetHistory(); revision++; setTool('select'); updateUI(); render(); autosave(); toast('ボードを開きました。');
    } catch (error) { toast(`ファイルを開けません: ${error.message}`); }
  }
  function confirmReplace() { return !fileDirty() || (!doc.elements.length && doc.title === '無題のボード') || confirm('現在のボードにはファイルに保存していない変更があります。保存せずに切り替えますか？'); }
  function newBoard() {
    finishEdit(); if (!confirmReplace()) return;
    doc = M.createDocument(); selected.clear(); savedSnapshot = contentSnapshot();
    resetHistory(); revision++; setTool('select'); updateUI(); render(); autosave();
  }
  function exportSVG() {
    finishEdit();
    if (!doc.elements.length) { toast('図形や付箋を追加してから書き出してください。'); return null; }
    const b = M.getBounds(doc.elements), padding = 40;
    const width = Math.max(1, Math.ceil(b.width + padding * 2)), height = Math.max(1, Math.ceil(b.height + padding * 2));
    const root = svg('svg', { xmlns: NS, width, height, viewBox: `${b.x - padding} ${b.y - padding} ${width} ${height}` });
    root.append(svg('title', {}, doc.title));
    root.append(svg('rect', { x: b.x - padding, y: b.y - padding, width, height, fill: '#ffffff' }));
    for (const el of doc.elements) root.append(renderElement(el));
    return { source: new XMLSerializer().serializeToString(root), width, height };
  }
  async function exportImage(kind) {
    $('export-dialog').close(); const result = exportSVG(); if (!result) return;
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
      download(blob, filename('.png')); toast('PNG画像を書き出しました。');
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
    if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); if (document.activeElement === $('board-title')) $('board-title').blur(); saveFile(); return; }
    if (isTyping(event.target) || event.isComposing) return;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') { event.preventDefault(); undo(event.shiftKey ? 1 : -1); }
    else if (mod && key === 'y') { event.preventDefault(); undo(1); }
    else if (mod && key === 'd') { event.preventDefault(); duplicate(); }
    else if (mod && key === 'a') { event.preventDefault(); selected = new Set(doc.elements.map(el => el.id)); updateUI(); render(); }
    else if (mod && key === 'o') { event.preventDefault(); $('file-input').click(); }
    else if (key === 'delete' || key === 'backspace') { event.preventDefault(); removeSelected(); }
    else if (key === 'escape') { if (gesture) endGesture(null, true); selected.clear(); setTool('select'); render(); updateUI(); }
    else if (key === ' ') { event.preventDefault(); spacePressed = true; stage.style.cursor = 'grab'; }
    else if (key === 'enter' && selected.size === 1) { event.preventDefault(); editText(getElement([...selected][0])); }
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
  init();
})();
