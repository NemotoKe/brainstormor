const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('src/app.js', 'utf8');
function setup(picker) {
  const ctx = vm.createContext({
    window: { showSaveFilePicker: picker }, Blob,
    M: { clone: structuredClone, serialize: JSON.stringify },
    finishEdit() {}, syncTitle() {}, autosave() {}, status() {}, toast() {},
    filename: () => 'new.brainstorm', contentSnapshot: JSON.stringify,
  });
  vm.runInContext(`
    let saving = false, restoring = false, currentFileHandle = null, currentFileName = '';
    let savedSnapshot = 'old', doc = { title: 'test', elements: [] };
    const canSaveDirectly = true;
    ${source.slice(source.indexOf('  async function saveFile('), source.indexOf('  async function chooseFile('))}
    globalThis.save = saveFile;
    globalThis.state = () => ({ currentFileName, savedSnapshot });
  `, ctx);
  return ctx;
}
test('first save selects a file, subsequent save overwrites it, save as switches destination', async () => {
  let picks = 0;
  const writes = [];
  const ctx = setup(async () => {
    const name = ++picks + '.brainstorm';
    return { name, async createWritable() { return {
      async write(data) { writes.push([name, data]); }, async close() {},
    }; } };
  });
  assert.equal(await ctx.save(), true);
  assert.equal(await ctx.save(), true);
  assert.equal(picks, 1);
  assert.equal(await ctx.save(true), true);
  assert.equal(picks, 2);
  assert.deepEqual(writes.map(x => x[0]), ['1.brainstorm', '1.brainstorm', '2.brainstorm']);
  assert.equal(ctx.state().currentFileName, '2.brainstorm');
});
test('cancel and failed writes leave saved state and destination unchanged', async () => {
  for (const picker of [
    async () => { throw Object.assign(new Error(), { name: 'AbortError' }); },
    async () => ({ name: 'failed.brainstorm', async createWritable() { return {
      async write() { throw new Error('disk full'); }, async abort() {},
    }; } }),
  ]) {
    const ctx = setup(picker);
    assert.equal(await ctx.save(), false);
    assert.equal(ctx.state().currentFileName, '');
    assert.equal(ctx.state().savedSnapshot, 'old');
  }
});
test('Escape commits text instead of restoring its old value', () => {
  let keydown, committed = false;
  const ctx = vm.createContext({
    editor: { addEventListener(type, cb) { if (type === 'keydown') keydown = cb; } },
    finishEdit(cancel = false) { committed = !cancel; },
    stage: { focus() {} },
  });
  const start = source.indexOf("  editor.addEventListener('keydown'");
  vm.runInContext(source.slice(start, source.indexOf("  editor.addEventListener('blur'", start)), ctx);
  keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(committed, true);
});
