import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
let html = await readFile(new URL('src/shell.html', root), 'utf8');
for (const [token, path] of [['/*__STYLES__*/','src/style.css'],['/*__MODEL__*/','src/model.js'],['/*__APP__*/','src/app.js']]) {
  if (!html.includes(token)) throw new Error(`Missing template token: ${token}`);
  const source = await readFile(new URL(path, root), 'utf8');
  if (/<\/script/i.test(source) && path.endsWith('.js')) throw new Error('Unsafe closing script tag in source');
  html = html.replace(token, () => source);
}
await writeFile(new URL('brainstormor.html', root), html);
await writeFile(new URL('index.html', root), html);
console.log(`Built ${fileURLToPath(new URL('brainstormor.html', root))} (${Math.round(Buffer.byteLength(html)/1024)} KB)`);
