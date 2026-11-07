const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/../index.html`, 'utf8');
const start = html.indexOf('  function openSampleManager(');
const end = html.indexOf('  async function loadFiles(', start);
assert(start > 0 && end > start);

function element() {
  return {
    children: [], classList: { toggle() {} }, hidden: false,
    append(item) { this.children.push(item); },
    set innerHTML(value) { this.children = []; },
  };
}
const elements = Object.fromEntries(
  ['sampleManager', 'sampleKits', 'sampleTypes', 'sampleList', 'sampleStatus', 'sampleRetry', 'sampleUse']
    .map(id => [id, element()])
);
const catalogUrl = 'https://example.test/kits/index.json';
const requests = [];
let handler;
let started = [];
const context = {
  URL, Promise, Error, Set, console,
  SAMPLE_KIT_CATALOG_URL: catalogUrl,
  $: id => elements[id],
  document: { createElement: element },
  fetch: async url => { requests.push(url); return handler(url); },
  ctx: {
    currentTime: 0,
    decodeAudioData: async bytes => ({ length: bytes.byteLength }),
    createBufferSource: () => ({
      connect() {}, start() { started.push(this.buffer); }, stop() {},
    }),
  },
  master: {}, ensureCtx() {}, kill() {}, resetPadAudioSettings() {}, buildGrid() {},
  PADS_PER_BANK: 12,
};
vm.createContext(context);
vm.runInContext(`
  let sampleTarget = null, previewVoice = null, lastPad = 0;
  const pads = Array.from({length: 24}, () => ({}));
  const sampleState = {kits: null, kit: 0, type: '', selected: null, message: '', retry: null, request: 0};
  ${html.slice(start, end)}
`, context);
const run = code => vm.runInContext(code, context);
const json = (data, url) => ({ ok: true, url, json: async () => data });
const audio = () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
const catalog = { kits: [
  { id: 'one', name: 'First', manifest: 'one/kit.json' },
  { id: 'two', name: 'Second', manifest: 'two/kit.json' },
] };
const first = { id: 'one', samples: [
  { type: 'Kick', name: 'Kick 1', url: 'samples/1.m4a' },
  { type: 'Kick', name: 'Kick 2', url: 'samples/2.m4a' },
] };
const second = { id: 'two', samples: [{ type: 'Snare', name: 'Snare 1', url: '../shared/3.m4a' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) {
  for (let i = 0; i < 100 && !condition(); i++) await tick();
  assert(condition(), 'condition did not become true');
}
const err = { ok: false, status: 503 };

async function main() {
  handler = async url => {
    if (url === catalogUrl) return json(catalog, catalogUrl);
    if (url.endsWith('/one/kit.json')) return json(first, url);
    if (url.endsWith('/two/kit.json')) return json(second, url);
    if (url.endsWith('.m4a')) return audio();
    throw Error(`Unexpected URL ${url}`);
  };
  run('openSampleManager(0, 3)');
  await until(() => run('Array.isArray(sampleState.kits?.[0]?.samples)'));
  assert.equal(elements.sampleKits.children.length, 2);
  assert.equal(elements.sampleList.children.length, 2);
  assert.deepEqual(requests, [catalogUrl, 'https://example.test/kits/one/kit.json']);
  assert.equal(run('sampleState.kits[0].samples[0].url'), 'https://example.test/kits/one/samples/1.m4a');
  elements.sampleList.children[0].onclick();
  await until(() => started.length === 1);
  await run('useSelectedSample()');
  assert.equal(run('pads[3].name'), 'Kick 1');
  assert.equal(run('pads[3].buffer.length'), 3);
  assert.equal(requests.filter(url => url.endsWith('/1.m4a')).length, 1);
  assert.equal(elements.sampleManager.hidden, true);

  run('openSampleManager(1, 0)');
  elements.sampleKits.children[1].onclick();
  await until(() => run('sampleState.kits[1].samples !== null'));
  assert.equal(run('sampleState.kits[1].samples[0].url'), 'https://example.test/kits/shared/3.m4a');
  assert.equal(elements.sampleList.children[0].textContent, 'Snare 1');

  let release;
  handler = url => url.endsWith('/3.m4a') ? new Promise(resolve => { release = resolve; }) : audio();
  elements.sampleList.children[0].onclick();
  await until(() => !!release);
  elements.sampleKits.children[0].onclick();
  release(audio());
  await tick();
  assert.equal(started.length, 1, 'stale preview must not start after kit changes');
  assert.equal(run('sampleState.selected'), null);

  let releaseUse;
  handler = url => url.endsWith('/2.m4a') ? new Promise(resolve => { releaseUse = resolve; }) : audio();
  elements.sampleList.children[1].onclick();
  await until(() => !!releaseUse);
  const pendingUse = run('useSelectedSample()');
  run('closeSampleManager()');
  releaseUse(audio());
  await pendingUse;
  assert.equal(run('pads[12].name'), undefined, 'closed manager must not assign an async load');

  handler = async () => err;
  run('sampleState.kits = null; openSampleManager(0, 0)');
  await until(() => run('sampleState.retry === "catalog"'));
  assert.match(elements.sampleStatus.textContent, /503/);
  assert.equal(elements.sampleRetry.hidden, false);
  handler = async url => url === catalogUrl ? json(catalog, url) : json(first, url);
  await run('loadSampleCatalog()');
  assert.equal(run('sampleState.kits[0].samples.length'), 2);

  handler = async url => url.endsWith('/two/kit.json') ? err : json(catalog, url);
  elements.sampleKits.children[1].onclick();
  await until(() => run('sampleState.retry === "kit"'));
  assert.match(elements.sampleStatus.textContent, /503/);
  handler = async url => json(second, url);
  await run('loadSampleKit()');
  assert.equal(run('sampleState.kits[1].samples.length'), 1);

  let releaseKit;
  run('sampleState.kits[1].samples = null');
  handler = url => url.endsWith('/two/kit.json')
    ? new Promise(resolve => { releaseKit = resolve; }) : json(first, url);
  const pendingKit = run('loadSampleKit()');
  await until(() => !!releaseKit);
  elements.sampleKits.children[0].onclick();
  releaseKit(json(second, 'https://example.test/kits/two/kit.json'));
  await pendingKit;
  assert.equal(run('sampleState.kit'), 0);
  assert.equal(run('sampleState.kits[1].samples'), null);

  handler = async () => err;
  run('sampleState.kits[0].samples[0].buffer = null');
  elements.sampleList.children[0].onclick();
  await until(() => elements.sampleStatus.textContent.includes('Could not preview'));
  assert.match(elements.sampleStatus.textContent, /503/);
  handler = async () => audio();
  elements.sampleList.children[0].onclick();
  await until(() => run('!!sampleState.selected.buffer'));

  let releaseCatalog;
  handler = () => new Promise(resolve => { releaseCatalog = resolve; });
  run('sampleState.kits = null');
  const pendingCatalog = run('loadSampleCatalog()');
  await until(() => !!releaseCatalog);
  run('closeSampleManager()');
  releaseCatalog(json(catalog, catalogUrl));
  await pendingCatalog;
  assert.equal(run('sampleState.kits'), null);

  run('sampleState.kits = null');
  handler = async url => json({ kits: [{ id: 'bad' }] }, url);
  await run('loadSampleCatalog()');
  assert.equal(run('sampleState.retry'), 'catalog');
  handler = async url => json({ kits: [] }, url);
  await run('loadSampleCatalog()');
  assert.match(elements.sampleStatus.textContent, /No drum kits/);
  run('closeSampleManager(); openSampleManager(0, 0)');
  assert.match(elements.sampleStatus.textContent, /No drum kits/);
  console.log('Catalog, lazy multi-kit URLs, preview, assignment, caching, races, retries and validation passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
