(() => {
  'use strict';
  const T = window.BrainstormorMermaidTemplates, F = window.BrainstormorDiagramModel;
  const $ = id => document.getElementById(id);
  const KEY = 'brainstormor-mermaid-drafts-v1', MAX_SOURCE = 50000;
  const drafts = new Map(), previews = new Map();
  let activeId, form = null, mode = 'source', timer, version = 0, formInvalid = false, services;
  function normalizeSource(source) {
    const text = source.trim();
    const fenced = /^```(?:mermaid)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
    return fenced ? fenced[1] : source;
  }
  function detectType(source) {
    const text = normalizeSource(source).trim().replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const first = text.split(/\r?\n/).find(line => line.trim() && !line.trim().startsWith('%%'))?.trim() || '';
    const types = [['sequenceDiagram', 'sequence'], ['flowchart', 'flowchart'], ['graph', 'flowchart'], ['classDiagram', 'class'], ['erDiagram', 'er'], ['stateDiagram', 'state'], ['gantt', 'gantt'], ['mindmap', 'mindmap'], ['pie', 'pie']];
    return types.find(([keyword]) => new RegExp(`^${keyword}(?:\\b|-)`).test(first))?.[1] || null;
  }
  function getDraft(id) {
    if (!drafts.has(id)) {
      const template = T.getTemplate(id);
      drafts.set(id, { title: template.title, source: template.source });
    }
    return drafts.get(id);
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(drafts))); $('diagram-draft-status').textContent = '下書きをこのブラウザに保存しました'; }
    catch { $('diagram-draft-status').textContent = '下書きの一時保存ができません。.mmdで保存してください'; }
  }
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      for (const template of T.templates) {
        const draft = saved?.[template.id];
        if (draft && typeof draft.source === 'string' && draft.source.length <= MAX_SOURCE && typeof draft.title === 'string') drafts.set(template.id, { source: draft.source, title: draft.title.slice(0, 100) });
      }
    } catch { /* A fresh editor is available even when browser storage is unavailable. */ }
  }
  function error(message = '') { $('diagram-error').textContent = message; $('diagram-error').hidden = !message; }
  function buttons() {
    const source = getDraft(activeId).source;
    $('diagram-save-code').disabled = $('diagram-copy').disabled = formInvalid || !source.trim();
    $('diagram-save-svg').disabled = formInvalid || previews.get(activeId)?.source !== source;
    $('diagram-discard-invalid').hidden = !formInvalid;
  }
  function canLeaveForm() {
    if (!formInvalid) return true;
    error('空欄などの入力を修正するか、「未確定の入力を取り消す」を選んでください。');
    return false;
  }
  function queuePreview(delay = 300) {
    clearTimeout(timer);
    const ticket = ++version, id = activeId, source = getDraft(id).source;
    $('diagram-save-svg').disabled = true;
    $('diagram-preview-status').textContent = '図を更新しています…';
    timer = setTimeout(async () => {
      try {
        if (!source.trim()) throw new Error('Mermaidコードを入力してください。');
        if (source.length > MAX_SOURCE) throw new Error('コードは50,000文字以内にしてください。');
        const result = await window.BrainstormorMermaidRenderer.render(source);
        if (ticket !== version || id !== activeId) return;
        previews.set(id, { source, svg: result.svg });
        // Only the local renderer's sanitized SVG is inserted as markup.
        $('diagram-preview').innerHTML = result.svg;
        $('diagram-preview-status').textContent = '最新の図を表示しています';
        error(); buttons();
      } catch (failure) {
        if (ticket !== version || id !== activeId) return;
        $('diagram-preview-status').textContent = previews.has(id) ? '最後に表示できた図です' : '図を表示できません';
        error(`コードを確認してください。${previews.has(id) ? 'プレビューには最後に表示できた図を残しています。' : ''}\n${String(failure.message || failure).slice(0, 1600)}`);
        buttons();
      }
    }, delay);
  }
  function updateFormMode() {
    const available = !!F.parse(getDraft(activeId).source);
    const button = document.querySelector('[data-diagram-mode="form"]');
    button.disabled = !available;
    $('diagram-form-hint').textContent = available
      ? '接続先は一覧から選びます。名前を変えても、矢印のつながりは維持されます。'
      : 'この図はコードで編集します。かんたん編集は基本的なシーケンス図・フローチャートに対応しています。';
    if (!available) mode = 'source';
    $('sequence-form').hidden = mode !== 'form'; $('diagram-source-pane').hidden = mode !== 'source';
    document.querySelectorAll('[data-diagram-mode]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.diagramMode === mode)));
  }
  function select(options, value, label, change) {
    const element = document.createElement('select'); element.setAttribute('aria-label', label);
    for (const [key, text] of options) { const option = document.createElement('option'); option.value = key; option.textContent = text; element.append(option); }
    element.value = value; element.addEventListener('change', () => change(element.value)); return element;
  }
  function action(text, label, handler) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button quiet-button'; button.textContent = text; button.setAttribute('aria-label', label); button.addEventListener('click', handler); return button;
  }
  function commitForm(rerender = false) {
    try {
      const source = F.serialize(form);
      getDraft(activeId).source = source; $('diagram-code').value = source; formInvalid = false;
      error(); persist(); buttons(); queuePreview();
      if (rerender) renderForm();
      else refreshRoutes();
    } catch (failure) {
      formInvalid = true; clearTimeout(timer); version++;
      error(failure.message); $('diagram-preview-status').textContent = '入力の修正を待っています'; buttons();
      if (rerender) renderForm();
    }
  }
  function refreshRoutes() {
    document.querySelectorAll('#sequence-messages select[data-route]').forEach(element => {
      const value = element.value;
      element.replaceChildren(...form.nodes.map(node => { const option = document.createElement('option'); option.value = node.id; option.textContent = node.text || '（名前を入力）'; return option; }));
      element.value = value;
    });
  }
  function renderForm() {
    const sequence = form.kind === 'sequence';
    $('sequence-node-heading').textContent = sequence ? '参加者' : '工程と条件分岐';
    $('sequence-link-heading').textContent = sequence ? 'メッセージ（上から順に送信）' : '矢印と接続先';
    $('sequence-add-participant').textContent = sequence ? '＋ 参加者を追加' : '＋ 工程を追加';
    $('sequence-add-message').textContent = sequence ? '＋ メッセージを追加' : '＋ 矢印を追加';
    $('sequence-add-participant').disabled = form.nodes.length >= (sequence ? 12 : 30);
    $('sequence-add-message').disabled = form.links.length >= (sequence ? 50 : 100);
    const nodes = $('sequence-participants'); nodes.replaceChildren();
    form.nodes.forEach((node, index) => {
      const row = document.createElement('div'); row.className = 'sequence-participant-row';
      const label = document.createElement('label'); label.textContent = `${sequence ? '参加者' : '工程'} ${index + 1}`;
      const input = document.createElement('input'); input.value = node.text; input.maxLength = sequence ? 100 : 500; input.dataset.nodeId = node.id;
      input.addEventListener('input', () => { node.text = input.value; commitForm(); }); label.append(input); row.append(label);
      if (!sequence) row.append(select([['rect', '工程（四角）'], ['diamond', '条件分岐'], ['ellipse', '開始・終了']], node.shape, `工程 ${index + 1} の図形`, value => { node.shape = value; commitForm(); }));
      const remove = action('削除', `${sequence ? '参加者' : '工程'} ${index + 1} を削除`, () => {
        try { form = F.removeNode(form, node.id); commitForm(true); } catch (failure) { services.toast(failure.message); }
      });
      remove.disabled = form.nodes.length <= (sequence ? 2 : 1) || form.links.some(link => link.from === node.id || link.to === node.id);
      remove.title = remove.disabled ? '接続中の項目は、先に矢印を変更・削除してください。' : 'この項目を削除'; row.append(remove); nodes.append(row);
    });
    const links = $('sequence-messages'); links.replaceChildren();
    form.links.forEach((link, index) => {
      const row = document.createElement('div'); row.className = 'sequence-message-row';
      const route = document.createElement('div'); route.className = 'sequence-message-route';
      const number = document.createElement('span'); number.className = 'sequence-step'; number.textContent = String(index + 1); route.append(number);
      const options = form.nodes.map(node => [node.id, node.text]);
      for (const [property, title] of [['from', sequence ? '送信元' : '接続元'], ['to', sequence ? '送信先' : '接続先']]) {
        if (property === 'to') { const arrow = document.createElement('span'); arrow.textContent = '→'; route.append(arrow); }
        const field = select(options, link[property], `${index + 1} ${title}`, value => { link[property] = value; commitForm(true); });
        field.dataset.route = property; route.append(field);
      }
      route.append(select([['request', sequence ? '送信 →' : '実線'], ['reply', sequence ? '応答 ⇢' : '破線']], link.kind, `${index + 1} 線の種類`, value => { link.kind = value; commitForm(); }));
      const text = document.createElement('textarea'); text.value = link.text; text.rows = 2; text.maxLength = 500;
      text.setAttribute('aria-label', `${index + 1} ${sequence ? 'メッセージ' : '矢印のラベル'}`); text.placeholder = sequence ? '送る内容' : 'はい・いいえ など（任意）';
      text.addEventListener('input', () => { link.text = text.value; commitForm(); });
      const actions = document.createElement('div'); actions.className = 'sequence-message-actions';
      if (sequence) for (const [delta, glyph, name] of [[-1, '↑', '上へ'], [1, '↓', '下へ']]) {
        const move = action(glyph, `${index + 1} を${name}`, () => { const [item] = form.links.splice(index, 1); form.links.splice(index + delta, 0, item); commitForm(true); });
        move.disabled = index + delta < 0 || index + delta >= form.links.length; actions.append(move);
      }
      actions.append(action('削除', `${index + 1} ${sequence ? 'メッセージ' : '矢印'}を削除`, () => { form.links.splice(index, 1); commitForm(true); }));
      row.append(route, text, actions); links.append(row);
    });
  }
  function activate(id) {
    clearTimeout(timer); version++; activeId = id; formInvalid = false;
    const draft = getDraft(id); $('diagram-type').value = id; $('diagram-title').value = draft.title; $('diagram-code').value = draft.source;
    form = F.parse(draft.source); mode = form ? 'form' : 'source';
    $('diagram-preview').innerHTML = previews.get(id)?.svg || '';
    if (form) renderForm(); updateFormMode(); error(); buttons(); persist(); queuePreview(0);
  }
  function open(id = 'sequence', source, title) {
    if (!canLeaveForm()) return;
    if (source !== undefined) {
      if (source.length > MAX_SOURCE) { services.toast('コードは50,000文字以内にしてください。'); return; }
      source = normalizeSource(source);
      drafts.set(id, { source, title: (title || T.getTemplate(id).title).slice(0, 100) });
    }
    if (!$('diagram-dialog').open) $('diagram-dialog').showModal();
    activate(id);
  }
  async function readFile(file) {
    if (!file) return;
    try {
      if (file.size > 200000) throw new Error('Mermaidファイルは200KB以下にしてください。');
      const source = await file.text();
      if (source.length > MAX_SOURCE) throw new Error('コードは50,000文字以内にしてください。');
      const id = detectType(source);
      if (!id) throw new Error('対応する図の種類を読み取れません。先頭にMermaidの図の種類を指定してください。');
      open(id, source, file.name.replace(/\.[^.]+$/, ''));
    } catch (failure) { services.toast(failure.message); }
  }
  function filename(extension) { return (getDraft(activeId).title.trim() || 'Mermaidの図').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 100) + extension; }
  function initialize(options) {
    services = options; restore();
    for (const template of T.templates) { const option = document.createElement('option'); option.value = template.id; option.textContent = template.title; $('diagram-type').append(option); }
    $('diagram-type').addEventListener('change', event => { if (canLeaveForm()) activate(event.target.value); else event.target.value = activeId; });
    $('diagram-title').addEventListener('input', event => { getDraft(activeId).title = event.target.value; persist(); });
    $('close-diagram').addEventListener('click', () => { if (canLeaveForm()) $('diagram-dialog').close(); });
    $('diagram-dialog').addEventListener('cancel', event => { if (!canLeaveForm()) event.preventDefault(); });
    $('diagram-dialog').addEventListener('close', () => { clearTimeout(timer); version++; });
    document.querySelectorAll('[data-diagram-mode]').forEach(button => button.addEventListener('click', () => {
      if (formInvalid) { error('入力中の項目を修正してから、編集方法を切り替えてください。'); return; }
      if (button.dataset.diagramMode === 'form') { form = F.parse(getDraft(activeId).source); if (!form) return; renderForm(); }
      mode = button.dataset.diagramMode; updateFormMode();
    }));
    $('diagram-code').addEventListener('input', event => { getDraft(activeId).source = event.target.value; formInvalid = false; persist(); updateFormMode(); buttons(); queuePreview(); });
    $('sequence-add-participant').addEventListener('click', () => {
      const limit = form.kind === 'sequence' ? 12 : 30; if (form.nodes.length >= limit) return;
      let number = 1; while (form.nodes.some(node => node.id === `p${number}`)) number++;
      form.nodes.push({ id: `p${number}`, text: form.kind === 'sequence' ? `参加者 ${number}` : '新しい工程', shape: 'rect' }); commitForm(true);
      const input = $('sequence-participants').lastElementChild.querySelector('input'); input.focus(); input.select();
    });
    $('sequence-add-message').addEventListener('click', () => {
      if (form.links.length >= (form.kind === 'sequence' ? 50 : 100)) return;
      form.links.push({ from: form.nodes[0].id, to: (form.nodes[1] || form.nodes[0]).id, text: form.kind === 'sequence' ? 'メッセージ' : '', kind: 'request' }); commitForm(true);
      const input = $('sequence-messages').lastElementChild.querySelector('textarea'); input.focus(); input.select();
    });
    $('diagram-discard-invalid').addEventListener('click', () => { form = F.parse(getDraft(activeId).source); formInvalid = false; renderForm(); error(); buttons(); queuePreview(0); });
    $('diagram-open-file').addEventListener('click', () => { if (canLeaveForm()) $('diagram-file-input').click(); });
    $('diagram-file-input').addEventListener('change', event => { readFile(event.target.files[0]); event.target.value = ''; });
    $('diagram-save-code').addEventListener('click', () => { if (!formInvalid) { services.download(new Blob([getDraft(activeId).source], { type: 'text/plain;charset=utf-8' }), filename('.mmd')); services.toast('Mermaidファイルを保存しました。'); } });
    $('diagram-save-svg').addEventListener('click', () => {
      const preview = previews.get(activeId); if (!formInvalid && preview?.source === getDraft(activeId).source) services.download(new Blob([preview.svg], { type: 'image/svg+xml;charset=utf-8' }), filename('.svg'));
    });
    $('diagram-copy').addEventListener('click', async () => {
      if (formInvalid) return;
      try { await navigator.clipboard.writeText(getDraft(activeId).source); services.toast('Mermaidコードをコピーしました。'); }
      catch { mode = 'source'; updateFormMode(); $('diagram-code').focus(); $('diagram-code').select(); services.toast('コードを選択しました。⌘ / Ctrl + C でコピーしてください。'); }
    });
  }
  window.BrainstormorDiagramEditor = Object.freeze({ initialize, open, readFile, detectType });
})();
