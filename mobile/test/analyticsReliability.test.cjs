const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');

const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, filename);
};
const { startAnalyticsRead } = require('../src/analyticsRead.ts');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function readPanel(load, saved, online = true) {
  const display = [];
  const errors = [];
  const stop = startAnalyticsRead({
    online,
    load,
    readSaved: () => Promise.resolve(saved),
    showLive: (value) => display.push(['live', value]),
    showSaved: (value) => display.push(['saved', value]),
    showError: (error) => errors.push(error),
    setFetching: () => {},
  });
  return { display, errors, stop };
}

test('la respuesta rápida gana al respaldo aunque WhatsApp siga pendiente', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const metrics = readPanel(async () => 12, 5);
  const phones = readPanel(() => new Promise(() => {}), ['old']);
  await flush();
  assert.deepEqual(metrics.display, [['live', 12]]);
  t.mock.timers.tick(350);
  assert.deepEqual(metrics.display, [['live', 12]]);
  assert.deepEqual(phones.display, [['saved', ['old']]]);
  metrics.stop();
  phones.stop();
});

test('una falla temporal conserva el último valor y reintenta hasta aceptar incluso un arreglo vacío', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const panel = readPanel(async () => {
    calls++;
    if (calls === 1) throw new TypeError('Network request failed');
    if (calls === 2) throw Object.assign(new Error('Ocupado'), { status: 503 });
    return [];
  }, ['old']);
  await flush();
  assert.deepEqual(panel.display.at(-1), ['saved', ['old']]);
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(3_999);
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(panel.display.at(-1), ['live', []]);
  assert.deepEqual(panel.errors, []);
  t.mock.timers.tick(30_000);
  assert.equal(calls, 3);
  panel.stop();
});

test('sin red solo abre la copia solicitada, sin copia mantiene el panel pendiente', async () => {
  const never = () => assert.fail('no debe llamar al servidor');
  const withCache = readPanel(never, [10], false);
  const withoutCache = readPanel(never, undefined, false);
  await flush();
  assert.deepEqual(withCache.display, [['saved', [10]]]);
  assert.deepEqual(withoutCache.display, []);
  assert.deepEqual(withoutCache.errors, []);
  withCache.stop();
  withoutCache.stop();
});

test('al cambiar de rango cancela la lectura y descarta la respuesta anterior', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  let requestSignal;
  const old = readPanel((signal) => {
    requestSignal = signal;
    return new Promise((resolve) => { finish = resolve; });
  }, [1]);
  old.stop();
  finish([2]);
  await flush();
  t.mock.timers.tick(1_000);
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(old.display, []);
});

test('un rechazo de permisos sigue siendo visible y no se reintenta', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const denied = Object.assign(new Error('Sin acceso'), { status: 403 });
  const panel = readPanel(async () => { calls++; throw denied; }, [4]);
  await flush();
  t.mock.timers.tick(60_000);
  assert.deepEqual(panel.errors, [denied]);
  assert.deepEqual(panel.display, []);
  assert.equal(calls, 1);
  panel.stop();
});

test('una respuesta interrumpida no cuenta como lista vacía de mensajes o analíticas', async (t) => {
  // Node does not load Expo's native file module; JSON reads never use it.
  const fileModule = require.resolve('expo-file-system/legacy');
  const previousModule = require.cache[fileModule];
  require.cache[fileModule] = { exports: {} };
  t.after(() => {
    if (previousModule) require.cache[fileModule] = previousModule;
    else delete require.cache[fileModule];
  });
  const { RistakApiClient } = require('../src/api.ts');
  const api = new RistakApiClient('http://localhost');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('<html>'));
  await assert.rejects(api.getConversation('contact', 50), { code: 'invalid_response' });
  await assert.rejects(api.getFinancialOverview('2026-01-01', '2026-01-31'), { code: 'invalid_response' });
  fetch.mock.mockImplementation(async () => Response.json({ success: true, data: [] }));
  assert.deepEqual(await api.getConversation('contact', 50), []);
  assert.deepEqual(await api.getFinancialOverview('2026-01-01', '2026-01-31'), []);
});

function createSnapshotTestStorage(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const files = new Map();
  const fileModule = require.resolve('expo-file-system/legacy');
  const previousModule = require.cache[fileModule];
  require.cache[fileModule] = { exports: {
    documentDirectory: '/cache-test/',
    getInfoAsync: async (key) => ({ exists: key.endsWith('/') || files.has(key), size: files.get(key)?.length || 0 }),
    readAsStringAsync: async (key) => files.get(key),
    writeAsStringAsync: async (key, value) => { files.set(key, value); },
  } };
  const cacheModule = require.resolve('../src/cache.ts');
  const snapshotModule = require.resolve('../src/analyticsSnapshots.ts');
  const coldBoot = (namespace = 'operator-1') => {
    delete require.cache[cacheModule];
    delete require.cache[snapshotModule];
    require(cacheModule).setCacheNamespace(namespace);
    return (query) => require(snapshotModule).analyticsSnapshot(query, namespace);
  };
  t.after(() => {
    delete require.cache[cacheModule];
    delete require.cache[snapshotModule];
    if (previousModule) require.cache[fileModule] = previousModule;
    else delete require.cache[fileModule];
  });
  return coldBoot;
}

test('salvo datos por moneda y zona; un rechazo invalida todos los rangos incluso tras reiniciar sin red', async (t) => {
  const coldBoot = createSnapshotTestStorage(t);
  const { analyticsMetricsCacheKey } = require('../src/cacheKeys.ts');
  const report = { startDate: '2026-10-01', endDate: '2026-10-31', timezone: 'America/Ciudad_Juarez', currency: 'MXN' };
  const first = analyticsMetricsCacheKey(report);
  const second = analyticsMetricsCacheKey({ ...report, startDate: '2026-10-15' });
  let open = coldBoot();
  await open(first).save(420);
  await open(second).save(125);
  t.mock.timers.tick(450);
  await flush();
  open = coldBoot();
  assert.deepEqual(await open(first).read(), { value: 420 });
  assert.equal(await open(analyticsMetricsCacheKey({ ...report, timezone: 'Europe/Madrid' })).read(), undefined);
  assert.equal(await open(analyticsMetricsCacheKey({ ...report, currency: 'EUR' })).read(), undefined);
  const staleRequest = open(second);
  open(first).revoke();
  await staleRequest.save(999);
  await flush();
  open = coldBoot();
  assert.equal(await open(first).read(), undefined);
  assert.equal(await open(second).read(), undefined);
  await open(second).save(170);
  assert.deepEqual(await open(second).read(), { value: 170 });
  assert.equal(await open(first).read(), undefined);
});

test('cada panel restaura su último cierre del mismo selector y conserva el rango exacto al actualizar', async (t) => {
  const boot = createSnapshotTestStorage(t);
  const { analyticsReportQuery, analyticsChartCacheKey, analyticsFunnelCacheKey } = require('../src/cacheKeys.ts');
  const dec31 = { startDate: '2026-12-02', endDate: '2026-12-31', timezone: 'America/Ciudad_Juarez', currency: 'MXN' };
  const jan1 = { ...dec31, startDate: '2026-12-03', endDate: '2027-01-01' };
  const jan2 = { ...jan1, startDate: '2026-12-04', endDate: '2027-01-02' };
  const chart = (range, period = '30d', scope = 'all') => analyticsReportQuery(range, period, (r) => analyticsChartCacheKey(r, 'revenue-spend', scope));
  const funnel = (range, web = true) => analyticsReportQuery(range, '30d', (r) => analyticsFunnelCacheKey(r, 'all', web));
  let open = boot();
  await open(chart(dec31)).save([10]);
  await open(funnel(dec31)).save([30]);
  t.mock.timers.tick(450);
  await flush();

  open = boot();
  assert.deepEqual(await open(chart(jan1)).read(), { value: [10], previousEndDate: '2026-12-31' });
  assert.equal(await open(chart(jan1, '60d')).read(), undefined);
  assert.equal(await open(chart(jan1, 'custom')).read(), undefined);
  assert.equal(await open(chart(jan1, '30d', 'campaigns')).read(), undefined);
  assert.equal(await open(chart({ ...jan1, currency: 'EUR' })).read(), undefined);
  assert.equal(await open(chart({ ...jan1, timezone: 'Europe/Madrid' })).read(), undefined);
  assert.equal(await open(funnel(jan1, false)).read(), undefined);

  await open(chart(jan1)).save([]);
  assert.deepEqual(await open(chart(jan1)).read(), { value: [] });
  assert.deepEqual(await open(funnel(jan1)).read(), { value: [30], previousEndDate: '2026-12-31' });
  await open(chart(dec31)).save([99]);
  assert.deepEqual(await open(chart(jan2)).read(), { value: [], previousEndDate: '2027-01-01' });
  assert.deepEqual(await open(chart(dec31, 'custom')).read(), { value: [99] });
  open(chart(jan2)).revoke();
  assert.equal(await open(chart(jan2)).read(), undefined);
  assert.equal(await boot('operator-2')(funnel(jan1)).read(), undefined);
});

test('los carruseles de Analiticas conservan aire inicial y scroll hasta el borde', () => {
  const optionScrollStyle = appSource.match(
    /analyticsOptionScroll:\s*\{([\s\S]*?)\n\s*\},\s*analyticsOptionScroller:/,
  )?.[1] || '';
  const optionScrollerStyle = appSource.match(
    /analyticsOptionScroller:\s*\{([\s\S]*?)\n\s*\},\s*analyticsChip:/,
  )?.[1] || '';
  const scrollerUsages = appSource.match(
    /contentContainerStyle=\{styles\.analyticsOptionScroller\}/g,
  ) || [];

  assert.match(optionScrollStyle, /marginHorizontal:\s*-14/);
  assert.match(optionScrollerStyle, /paddingHorizontal:\s*14/);
  assert.match(optionScrollerStyle, /paddingRight:\s*18/);
  assert.equal(scrollerUsages.length, 2);
});
