(function (root, factory) {
  'use strict';
  const cjs = typeof module === 'object' && module.exports;
  const api = factory(cjs ? require('./model.js') : root.BrainstormorModel, cjs ? require('./mermaid.js') : root.BrainstormorMermaid, cjs ? require('./mermaid-templates.js') : root.BrainstormorMermaidTemplates);
  if (cjs) module.exports = api;
  if (root) root.BrainstormorDiagramModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, C, T) {
  'use strict';
  function parse(source) {
    const sequence = T.parseSequence(source);
    if (sequence) return { kind: 'sequence', nodes: sequence.participants.map(p => ({ id: p.id, text: p.name })), links: sequence.messages };
    try {
      // Keep annotations and unsupported styling in the code editor instead
      // of silently dropping them when a form field changes.
      if (source.includes('%%')) return null;
      const imported = C.importFlowchart(source);
      if (imported.warnings.length > 1) return null;
      const document = imported.document;
      if (document.elements.length > 130) return null;
      const direction = /(?:flowchart|graph)\s+(LR|RL|TB|TD|BT)\b/.exec(source)?.[1] || 'LR';
      const nodes = document.elements.filter(el => el.type !== 'arrow').map(el => ({ id: el.id, text: el.text, shape: el.type, element: el }));
      const links = document.elements.filter(el => el.type === 'arrow').map(el => ({ from: el.from.elementId, to: el.to.elementId, text: el.label, kind: el.lineStyle === 'dashed' ? 'reply' : 'request', element: el }));
      if (!nodes.length || nodes.length > 30 || links.length > 100) return null;
      return { kind: 'flowchart', nodes, links, direction };
    } catch { return null; }
  }
  function serialize(model) {
    if (!model || !Array.isArray(model.nodes) || !Array.isArray(model.links)) throw new Error('図の構造を読み取れません。');
    if (model.kind === 'sequence') return T.serializeSequence({ participants: model.nodes.map(n => ({ id: n.id, name: n.text })), messages: model.links });
    if (model.kind !== 'flowchart') throw new Error('この種類はコードで編集してください。');
    if (!model.nodes.length || model.nodes.length > 30 || model.links.length > 100) throw new Error('工程は1〜30個、矢印は100本以内にしてください。');
    const ids = new Set(model.nodes.map(n => n.id));
    if (ids.size !== model.nodes.length || model.nodes.some(n => typeof n.id !== 'string' || !n.id)) throw new Error('図形のIDが重複しています。');
    const document = M.createDocument('フローチャート');
    document.elements = model.nodes.map((node, index) => {
      if (!['rect', 'ellipse', 'diamond'].includes(node.shape)) throw new Error('工程の図形を選んでください。');
      if (typeof node.text !== 'string' || !node.text.trim() || node.text.length > 500) throw new Error(`${index + 1}個目の工程名を1〜500文字で入力してください。`);
      const element = node.element ? M.clone(node.element) : M.createItem(node.shape, { x: 260 * (index % 4), y: 160 * Math.floor(index / 4), width: 200, height: 100 });
      return { ...element, id: node.id, type: node.shape, text: node.text };
    });
    model.links.forEach((link, index) => {
      if (!ids.has(link.from) || !ids.has(link.to)) throw new Error(`${index + 1}本目の接続先を選んでください。`);
      if (!['request', 'reply'].includes(link.kind) || typeof link.text !== 'string' || link.text.length > 500) throw new Error(`${index + 1}本目の矢印の入力を確認してください。`);
      const element = link.element ? M.clone(link.element) : M.createItem('arrow');
      document.elements.push({ ...element, label: link.text, lineStyle: link.kind === 'reply' ? 'dashed' : 'solid', from: { ...element.from, elementId: link.from }, to: { ...element.to, elementId: link.to } });
    });
    return C.exportFlowchart(document, model.direction || 'LR').source;
  }
  function removeNode(model, id) {
    const minimum = model.kind === 'sequence' ? 2 : 1;
    if (model.nodes.length <= minimum) throw new Error(`少なくとも${minimum}個は残してください。`);
    if (model.links.some(link => link.from === id || link.to === id)) throw new Error('この項目は接続されています。先に矢印の接続先を変更するか、矢印を削除してください。');
    return { ...model, nodes: model.nodes.filter(node => node.id !== id) };
  }
  return Object.freeze({ parse, serialize, removeNode });
});
