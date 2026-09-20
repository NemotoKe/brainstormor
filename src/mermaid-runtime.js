(function (global) {
  'use strict';

  // The official, pinned Mermaid distribution is inlined immediately before
  // this adapter by scripts/build.mjs; rendering never needs a CDN.
  const mermaid = global.mermaid;
  const maximumLength = 100000;
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const forbiddenElements = new Set([
    'script', 'foreignobject', 'image', 'iframe', 'object', 'embed', 'audio',
    'video', 'canvas', 'link', 'meta', 'animate', 'animatetransform',
    'animatemotion', 'set', 'discard',
  ]);
  const fragment = /^#[A-Za-z_][\w:.-]*$/;
  let nextId = 0;
  let pending = Promise.resolve();

  function configure() {
    if (!mermaid) throw new Error('Mermaid の描画ライブラリを読み込めませんでした。');
    // Lock all configuration supplied by this app, including diagram-specific
    // HTML settings. Neither %%{init}%% nor YAML frontmatter can loosen them.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      fontFamily: 'Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif',
      theme: 'default',
      layout: 'dagre',
      maxTextSize: maximumLength,
      maxEdges: 1000,
      flowchart: { htmlLabels: false, useMaxWidth: false },
      class: { htmlLabels: false },
      secure: [...new Set([
        ...Object.keys(mermaid.mermaidAPI.defaultConfig),
        'securityLevel', 'htmlLabels', 'dompurifyConfig', 'secure', 'themeCSS',
        'fontFamily', 'layout', 'flowchart', 'class',
      ])],
    });
  }

  function sourceText(source) {
    const text = String(source ?? '').trim();
    if (!text) throw new Error('Mermaid のコードを入力してください。');
    if (text.length > maximumLength) throw new Error('Mermaid のコードは 100,000 文字以内にしてください。');
    // Block image/CSS resource loading before Mermaid constructs its temporary
    // DOM. Sanitizing the returned SVG alone would be too late to stop a fetch.
    if (/!\[[^\]]*\]\s*\(|\bimg\s*:|<\s*img\b|url\s*\(|@import\b/i.test(text)) {
      throw new Error('画像や外部CSSを読み込む構文は、この図のエディタでは使用できません。');
    }
    return text;
  }

  function safeCss(value) {
    // Mermaid's own generated styles use literal fragment URLs. Escaped CSS
    // and remote resources are unnecessary for an offline diagram preview.
    if (/\\|@(?:import|font-face|namespace|document)\b|expression\s*\(/i.test(value)) return '';
    return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, quote, url) => {
      const reference = url.trim();
      return fragment.test(reference) ? `url(${reference})` : 'none';
    });
  }

  function sanitizeSvg(source) {
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    const svg = parsed.documentElement;
    if (svg.localName !== 'svg' || parsed.querySelector('parsererror')) {
      throw new Error('図の SVG を生成できませんでした。');
    }
    for (const element of [svg, ...svg.querySelectorAll('*')]) {
      if (element.namespaceURI !== svgNamespace || forbiddenElements.has(element.localName.toLowerCase())) {
        element.remove();
        continue;
      }
      if (element.localName === 'a') {
        // Keep the diagram contents, but never expose Mermaid link actions.
        element.replaceWith(...element.childNodes);
        continue;
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (/^on/.test(name) || name === 'src' || name === 'srcset' || name === 'xml:base' ||
            ((name === 'href' || name === 'xlink:href') && !fragment.test(attribute.value))) {
          element.removeAttributeNode(attribute);
        } else if (name === 'style' || /url\s*\(/i.test(attribute.value)) {
          const value = safeCss(attribute.value);
          if (value) element.setAttribute(attribute.name, value);
          else element.removeAttributeNode(attribute);
        }
      }
      if (element.localName === 'style') element.textContent = safeCss(element.textContent);
    }
    return new XMLSerializer().serializeToString(svg);
  }

  // Mermaid keeps parser/configuration state globally. Serialize our parse and
  // render operations, and let the next operation proceed after a rejection.
  function enqueue(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  async function validate(source) {
    const text = sourceText(source);
    return enqueue(async () => {
      configure();
      await mermaid.parse(text);
    });
  }

  async function render(source) {
    const text = sourceText(source);
    return enqueue(async () => {
      configure();
      // Parse first so an invalid edit never yields an error diagram.
      await mermaid.parse(text);
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:-100000px;top:0;width:2000px;visibility:hidden;pointer-events:none;';
      document.body.append(host);
      try {
        const result = await mermaid.render(`brainstormor-diagram-${++nextId}`, text, host);
        // Do not call result.bindFunctions: previews have no external actions.
        return { svg: sanitizeSvg(result.svg) };
      } finally {
        host.remove();
      }
    });
  }

  configure();
  global.BrainstormorMermaidRenderer = Object.freeze({ render, validate });
})(window);
