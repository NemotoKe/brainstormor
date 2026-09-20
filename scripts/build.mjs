import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
let html = await readFile(new URL('src/shell.html', root), 'utf8');
const mermaidPackage = JSON.parse(await readFile(new URL('node_modules/mermaid/package.json', root), 'utf8'));
if (mermaidPackage.version !== '12.0.0') throw new Error('Run npm ci to install the pinned Mermaid version.');
const mermaidLicense = await readFile(new URL('licenses/mermaid-LICENSE.txt', root), 'utf8');
const mermaidDistribution = await readFile(new URL('node_modules/mermaid/dist/mermaid.min.js', root), 'utf8');
for (const [token, path] of [
  ['/*__STYLES__*/', 'src/style.css'],
  ['/*__MODEL__*/', 'src/model.js'],
  ['/*__FEATURES__*/', 'src/features.js'],
  ['/*__MERMAID__*/', 'src/mermaid.js'],
  ['/*__MERMAID_RUNTIME__*/', 'src/mermaid-runtime.js'],
  ['/*__MERMAID_TEMPLATES__*/', 'src/mermaid-templates.js'],
  ['/*__DIAGRAM_MODEL__*/', 'src/diagram-model.js'],
  ['/*__DIAGRAM_EDITOR__*/', 'src/diagram-editor.js'],
  ['/*__APP__*/', 'src/app.js'],
]) {
  if (!html.includes(token)) throw new Error(`Missing template token: ${token}`);
  let source = await readFile(new URL(path, root), 'utf8');
  if (token === '/*__MERMAID_RUNTIME__*/') {
    source = `/* Mermaid ${mermaidPackage.version}\n${mermaidLicense} */\n${mermaidDistribution}\n${source}`;
  }
  if (/<\/script/i.test(source) && path.endsWith('.js')) throw new Error('Unsafe closing script tag in source');
  html = html.replace(token, () => source);
}
await writeFile(new URL('brainstormor.html', root), html);
await writeFile(new URL('index.html', root), html);
console.log(`Built ${fileURLToPath(new URL('brainstormor.html', root))} (${Math.round(Buffer.byteLength(html)/1024)} KB)`);
