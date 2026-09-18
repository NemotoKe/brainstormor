(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BrainstormorModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT = 'brainstormor';
  const VERSION = 1;
  const LIMITS = Object.freeze({ fileBytes: 40 * 1024 * 1024, elements: 5000, coordinate: 10000000, dimension: 1000000, text: 200000, title: 10000, arrowLabel: 200 });
  const DEFAULTS = Object.freeze({ noteColor: '#fff2aa', textColor: '#24334a', arrowColor: '#526076', rectColor: '#daeafd', ellipseColor: '#d7f1e3', diamondColor: '#eee0ff', noteFontSize: 20, textFontSize: 24, shapeFontSize: 20, strokeWidth: 3 });
  const SHAPES = ['rect', 'ellipse', 'diamond'];
  const TRANSPARENT_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  let sequence = 0;

  function fail(message) { throw new Error(message); }
  function record(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name + 'の形式が正しくありません。');
    return value;
  }
  function string(value, name, maximum) {
    if (typeof value !== 'string' || value.length > maximum) fail(name + 'は' + maximum + '文字以内の文字列にしてください。');
    return value;
  }
  function number(value, name, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) fail(name + 'の数値が範囲外です。');
    return value;
  }
  function coordinate(value, name) { return number(value, name, -LIMITS.coordinate, LIMITS.coordinate); }
  function choice(value, choices, name) {
    if (!choices.includes(value)) fail(name + 'の形式が正しくありません。');
    return value;
  }
  function arrowLabel(value) {
    const label = value === undefined ? '' : value;
    if (typeof label !== 'string' || Array.from(label).length > LIMITS.arrowLabel) fail('矢印のラベルは200文字以内にしてください。');
    return label;
  }
  function color(value) {
    if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) fail('色の形式が正しくありません。');
    return value;
  }
  function id(value) {
    string(value, 'ID', 128);
    if (!value.trim()) fail('空のIDは使えません。');
    return value;
  }
  function newId() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    sequence += 1;
    return 'item-' + Date.now().toString(36) + '-' + sequence.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function byteLength(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(value, 'utf8');
    return unescape(encodeURIComponent(value)).length;
  }
  function imageSource(value) {
    if (typeof value !== 'string' || value.length > LIMITS.fileBytes) fail('画像データが大きすぎるか、形式が正しくありません。');
    // Only embedded raster files are allowed: no remote requests, SVG, or executable URLs.
    const match = /^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
    if (!match || match[2].length % 4 !== 0) fail('画像はPNG・JPEG・GIF・WebP・AVIF・BMPの埋め込みデータにしてください。');
    const prefix = match[2].slice(0, 64);
    let bytes;
    try {
      bytes = typeof atob === 'function' ? atob(prefix) : Buffer.from(prefix, 'base64').toString('latin1');
    } catch (_) { fail('画像の埋め込みデータが壊れています。'); }
    const mime = match[1].toLowerCase();
    const valid = mime === 'png' ? bytes.startsWith('\x89PNG\r\n\x1a\n')
      : mime === 'jpeg' || mime === 'jpg' ? bytes.startsWith('\xff\xd8\xff')
      : mime === 'gif' ? /^GIF8[79]a/.test(bytes)
      : mime === 'webp' ? bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP'
      : mime === 'avif' ? bytes.slice(4, 8) === 'ftyp' && /avif|avis/.test(bytes.slice(8))
      : bytes.startsWith('BM');
    if (!valid) fail('画像の内容とファイル形式が一致しません。');
    return value;
  }
  function endpoint(value, name) {
    record(value, name);
    const result = { x: coordinate(value.x, name + '.x'), y: coordinate(value.y, name + '.y') };
    if (value.elementId !== undefined && value.elementId !== null) result.elementId = id(value.elementId);
    return result;
  }
  function normalizeItem(value) {
    record(value, '要素');
    if (!['note', 'text', 'image', 'arrow', ...SHAPES].includes(value.type)) fail('未対応の要素が含まれています。');
    const result = {
      id: id(value.id), type: value.type,
      x: coordinate(value.x, 'x'), y: coordinate(value.y, 'y'),
      width: number(value.width, '幅', value.type === 'arrow' ? 0 : 0.01, LIMITS.dimension),
      height: number(value.height, '高さ', value.type === 'arrow' ? 0 : 0.01, LIMITS.dimension)
    };
    if (value.type === 'note' || value.type === 'text' || SHAPES.includes(value.type)) {
      result.text = string(value.text, 'テキスト', LIMITS.text);
      result.color = color(value.color);
      result.fontSize = number(value.fontSize, '文字サイズ', 1, 1000);
      if (SHAPES.includes(value.type) || (value.type === 'note' && value.textColor !== undefined)) {
        result.textColor = color(value.textColor === undefined ? DEFAULTS.textColor : value.textColor);
      }
    } else if (value.type === 'image') {
      result.src = imageSource(value.src);
      result.name = string(value.name, '画像名', 10000);
    } else {
      result.from = endpoint(value.from, '矢印の始点');
      result.to = endpoint(value.to, '矢印の終点');
      result.color = color(value.color);
      result.strokeWidth = number(value.strokeWidth === undefined ? DEFAULTS.strokeWidth : value.strokeWidth, '線の太さ', 0.1, 100);
      result.label = arrowLabel(value.label);
      result.lineStyle = choice(value.lineStyle === undefined ? 'solid' : value.lineStyle, ['solid', 'dashed'], '線のスタイル');
      result.head = choice(value.head === undefined ? 'end' : value.head, ['end', 'both', 'none'], '矢印の先端');
    }
    return result;
  }
  function normalizeDocument(value) {
    record(value, 'ファイル');
    if (value.format !== FORMAT) fail('Brainstormorのファイルではありません。');
    if (value.version !== VERSION) fail('このファイルのバージョンには対応していません。');
    if (!Array.isArray(value.elements) || value.elements.length > LIMITS.elements) fail('要素数は' + LIMITS.elements + '個以内にしてください。');
    const viewport = record(value.viewport, '表示位置');
    const result = {
      format: FORMAT, version: VERSION, title: string(value.title, 'タイトル', LIMITS.title),
      elements: value.elements.map(normalizeItem),
      viewport: { x: coordinate(viewport.x, '表示位置.x'), y: coordinate(viewport.y, '表示位置.y'), zoom: number(viewport.zoom, 'ズーム', 0.01, 100) }
    };
    const ids = new Set();
    const targets = new Set();
    for (const item of result.elements) {
      if (ids.has(item.id)) fail('要素のIDが重複しています。');
      ids.add(item.id);
      if (item.type !== 'arrow') targets.add(item.id);
    }
    for (const item of result.elements) {
      if (item.type !== 'arrow') continue;
      for (const point of [item.from, item.to]) {
        // Stored coordinates remain usable when the referenced element was deleted.
        if (point.elementId !== undefined && !targets.has(point.elementId)) delete point.elementId;
      }
    }
    return result;
  }
  function createDocument(title = '無題のボード') {
    return { format: FORMAT, version: VERSION, title: string(title, 'タイトル', LIMITS.title), elements: [], viewport: { x: 0, y: 0, zoom: 1 } };
  }
  function createItem(type, overrides = {}) {
    record(overrides, '要素の設定');
    const common = { id: newId(), type, x: 0, y: 0, width: 220, height: 150 };
    const defaults = type === 'note' ? { text: '', color: DEFAULTS.noteColor, fontSize: DEFAULTS.noteFontSize }
      : type === 'text' ? { width: 280, height: 52, text: '', color: DEFAULTS.textColor, fontSize: DEFAULTS.textFontSize }
      : SHAPES.includes(type) ? { width: type === 'diamond' ? 240 : 220, height: type === 'diamond' ? 160 : 130, text: '', color: DEFAULTS[type + 'Color'], fontSize: DEFAULTS.shapeFontSize, textColor: DEFAULTS.textColor }
      : type === 'image' ? { width: 400, height: 300, src: TRANSPARENT_IMAGE, name: '画像' }
      : type === 'arrow' ? { width: 0, height: 0, from: { x: 0, y: 0 }, to: { x: 160, y: 0 }, color: DEFAULTS.arrowColor, strokeWidth: DEFAULTS.strokeWidth, label: '', lineStyle: 'solid', head: 'end' }
      : {};
    return normalizeItem(Object.assign({}, common, defaults, overrides, { type }));
  }
  function parse(source) {
    if (typeof source !== 'string') fail('ファイルをテキストとして読み込めませんでした。');
    if (byteLength(source) > LIMITS.fileBytes) fail('ファイルは40MB以内にしてください。');
    let data;
    try { data = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source); }
    catch (_) { fail('JSONファイルが壊れているか、形式が正しくありません。'); }
    return normalizeDocument(data);
  }
  function serialize(document) {
    const source = JSON.stringify(normalizeDocument(document), null, 2) + '\n';
    if (byteLength(source) > LIMITS.fileBytes) fail('ファイルは40MB以内にしてください。');
    return source;
  }
  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
  function center(item) { return { x: item.x + item.width / 2, y: item.y + item.height / 2 }; }
  function edge(item, toward, fallbackDirection) {
    const origin = center(item);
    let dx = toward.x - origin.x;
    let dy = toward.y - origin.y;
    if (dx === 0 && dy === 0) dx = fallbackDirection;
    const normalizedX = Math.abs(dx) / (item.width / 2);
    const normalizedY = Math.abs(dy) / (item.height / 2);
    const distance = item.type === 'ellipse' ? Math.hypot(normalizedX, normalizedY)
      : item.type === 'diamond' ? normalizedX + normalizedY
      : Math.max(normalizedX, normalizedY);
    const factor = 1 / distance;
    return { x: origin.x + dx * factor, y: origin.y + dy * factor };
  }
  function arrowEndpoints(arrow, elements) {
    const items = elements instanceof Map ? elements : new Map((elements || []).map(item => [item.id, item]));
    const fromTarget = items.get(arrow.from.elementId);
    const toTarget = items.get(arrow.to.elementId);
    const fromItem = fromTarget && fromTarget.type !== 'arrow' ? fromTarget : null;
    const toItem = toTarget && toTarget.type !== 'arrow' ? toTarget : null;
    const fromCenter = fromItem ? center(fromItem) : arrow.from;
    const toCenter = toItem ? center(toItem) : arrow.to;
    return {
      from: fromItem ? edge(fromItem, toCenter, 1) : { x: arrow.from.x, y: arrow.from.y },
      to: toItem ? edge(toItem, fromCenter, -1) : { x: arrow.to.x, y: arrow.to.y }
    };
  }
  function arrowLabelLayout(arrow, elements) {
    if (typeof arrow.label !== 'string' || !arrow.label.trim()) return null;
    const lines = [];
    let contentWidth = 0;
    // Use the same deterministic metrics for the editor, exports, and framing.
    // Iterate code points so supplementary Unicode characters are never split.
    for (const paragraph of arrow.label.split(/\r\n|\r|\n/)) {
      let line = '', width = 0;
      for (const character of paragraph) {
        const advance = character.codePointAt(0) <= 0x7f ? 10 : 16;
        if (line && width + advance > 180) {
          lines.push(line);
          contentWidth = Math.max(contentWidth, width);
          line = ''; width = 0;
        }
        line += character;
        width += advance;
      }
      lines.push(line);
      contentWidth = Math.max(contentWidth, width);
    }
    const width = contentWidth + 16;
    const height = lines.length * 22 + 12;
    const endpoints = arrowEndpoints(arrow, elements);
    return {
      lines, width, height,
      x: (endpoints.from.x + endpoints.to.x) / 2 - width / 2,
      y: (endpoints.from.y + endpoints.to.y) / 2 - height / 2,
      lineHeight: 22
    };
  }
  function getBounds(elements) {
    if (!elements.length) return { x: 0, y: 0, width: 0, height: 0 };
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const items = new Map(elements.map(item => [item.id, item]));
    for (const item of elements) {
      if (item.type === 'arrow') {
        const points = arrowEndpoints(item, items);
        left = Math.min(left, points.from.x, points.to.x);
        top = Math.min(top, points.from.y, points.to.y);
        right = Math.max(right, points.from.x, points.to.x);
        bottom = Math.max(bottom, points.from.y, points.to.y);
        const label = arrowLabelLayout(item, items);
        if (label) {
          left = Math.min(left, label.x); top = Math.min(top, label.y);
          right = Math.max(right, label.x + label.width); bottom = Math.max(bottom, label.y + label.height);
        }
      } else {
        left = Math.min(left, item.x); top = Math.min(top, item.y);
        right = Math.max(right, item.x + item.width); bottom = Math.max(bottom, item.y + item.height);
      }
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  return { FORMAT, VERSION, LIMITS, DEFAULTS, createDocument, createItem, parse, serialize, clone, arrowEndpoints, arrowLabelLayout, getBounds };
});
