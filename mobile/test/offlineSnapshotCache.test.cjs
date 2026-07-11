const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const cacheSource = fs.readFileSync(path.join(__dirname, '../src/cache.ts'), 'utf8');
const cacheKeysSource = fs.readFileSync(path.join(__dirname, '../src/cacheKeys.ts'), 'utf8');

test('el bootstrap precarga snapshots de la sesion antes de exponer el shell', () => {
  const start = appSource.indexOf('const bootstrap = useCallback(async () => {');
  const end = appSource.indexOf('\n  const revalidateCurrentSession = useCallback', start);
  const bootstrap = appSource.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(bootstrap, /const sessionNamespace = getSessionCacheNamespace\(storedBaseUrl, storedToken\)/);
  assert.match(bootstrap, /setCacheNamespace\(sessionNamespace\);\s+await preloadCache\(sessionNamespace\);\s+}\s+commitSession/);
});

test('la cache de snapshots tiene RAM, precarga acotada y conserva vacios autoritativos', () => {
  assert.match(cacheSource, /const memory = new Map<string, unknown>\(\)/);
  assert.match(cacheSource, /const MAX_PRELOADED_ENTRIES = 180/);
  assert.match(cacheSource, /const MAX_PRELOADED_BYTES = 32 \* 1024 \* 1024/);
  assert.match(cacheSource, /export function peekCache<T>/);
  assert.match(cacheSource, /export function hasCachedValue/);
  assert.match(cacheSource, /export async function preloadCache/);
  assert.match(cacheSource, /Object\.prototype\.hasOwnProperty\.call\(parsed, 'v'\)/);
});

test('pagos, analiticas y ajustes hidratan su ultimo estado y revalidan sin ocultarlo', () => {
  for (const key of [
    'paymentAccountContext',
    'paymentAccess',
    'paymentProducts',
    'analyticsAccountContext',
    'settingsAppConfig',
    'settingsWhatsAppStatus',
    'settingsAIAgent',
  ]) {
    assert.match(cacheKeysSource, new RegExp(key));
  }

  assert.match(appSource, /writeCache\(MOBILE_CACHE_KEYS\.paymentAccess, nextAccess\)/);
  assert.match(appSource, /writeCache\(metricsCacheKey, metricsResult\.value\)/);
  assert.match(appSource, /writeCache\(MOBILE_CACHE_KEYS\.settingsWhatsAppStatus, status\)/);
  assert.match(appSource, /if \(!hasCachedRecentPayments\) \{\s+setRecentPayments\(\[\]\)/);
  assert.match(appSource, /if \(!silent && !hasCachedEventsForRange\) setLoading\(true\)/);
});
