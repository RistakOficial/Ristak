const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const progressSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'firstSyncProgress.ts'),
  'utf8',
);
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

test('el progreso inicial avanza por etapas reales y termina en 100%', () => {
  const fractions = [...progressSource.matchAll(/fraction:\s*([0-9.]+)/g)]
    .map((match) => Number(match[1]));

  assert.deepEqual(fractions, [...fractions].sort((left, right) => left - right));
  assert.equal(fractions.at(-1), 1);
  for (const stage of ['account', 'conversations', 'localCopy', 'complete']) {
    assert.match(progressSource, new RegExp(`id: '${stage}'`));
  }
  assert.doesNotMatch(progressSource, /id: 'settings'/);
  assert.doesNotMatch(progressSource, /id: 'contacts'/);
});

test('la primera sincronizacion pide el inbox primero y no bloquea por directorio/config', () => {
  const syncStart = appSource.indexOf('const runFirstSync = useCallback(async () => {');
  const syncEnd = appSource.indexOf('\n  useEffect(() => {', syncStart);
  const syncSource = appSource.slice(syncStart, syncEnd);
  const inboxLoad = syncSource.indexOf('const loadedChats = await loadChats(false)');
  const degradedBranch = syncSource.indexOf('if (!loadedChats)');
  const degradedCompletionWrite = appSource.indexOf(
    'writeCacheNow(MOBILE_CACHE_KEYS.firstSyncCompleted',
    syncStart + degradedBranch,
  );
  const inboxWrite = appSource.indexOf('writeCacheNow(NATIVE_INBOX_CACHE_KEY', degradedCompletionWrite);
  const successCompletionWrite = appSource.indexOf(
    'writeCacheNow(MOBILE_CACHE_KEYS.firstSyncCompleted',
    inboxWrite,
  );
  const completeStage = appSource.indexOf("stage: 'complete'", successCompletionWrite);

  assert.ok(syncStart >= 0);
  assert.ok(inboxLoad >= 0);
  assert.ok(degradedBranch > inboxLoad);
  assert.ok(degradedCompletionWrite > syncStart + degradedBranch);
  assert.ok(inboxWrite >= 0);
  assert.ok(successCompletionWrite > inboxWrite);
  assert.ok(completeStage > successCompletionWrite);
  assert.doesNotMatch(syncSource, /getPickerContacts/);
  assert.doesNotMatch(syncSource, /firstSyncContacts/);
  assert.doesNotMatch(syncSource, /getConfig/);
  assert.match(appSource, /Las conversaciones seguirán cargando en segundo plano/);
});
