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
  for (const stage of ['account', 'settings', 'contacts', 'conversations', 'localCopy', 'complete']) {
    assert.match(progressSource, new RegExp(`id: '${stage}'`));
  }
});

test('la pantalla solo marca completo después de guardar chats y la copia local', () => {
  const inboxWrite = appSource.indexOf('writeCacheNow(NATIVE_INBOX_CACHE_KEY');
  const completionWrite = appSource.indexOf('writeCacheNow(MOBILE_CACHE_KEYS.firstSyncCompleted');
  const completeStage = appSource.indexOf("stage: 'complete'", completionWrite);

  assert.ok(inboxWrite >= 0);
  assert.ok(completionWrite > inboxWrite);
  assert.ok(completeStage > completionWrite);
});
