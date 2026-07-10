const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');

test('metricas, origen y telefonos fallan de forma independiente', () => {
  const start = appSource.indexOf('const loadOverview = useCallback(async () => {');
  const end = appSource.indexOf('\n  useEffect(() => {', start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const loadOverviewSource = appSource.slice(start, end);
  assert.match(loadOverviewSource, /if \(metricsResult\.status === 'fulfilled'\)/);
  assert.match(loadOverviewSource, /if \(originResult\.status === 'fulfilled'\)/);
  assert.match(loadOverviewSource, /if \(whatsappResult\.status === 'fulfilled'\)/);
  assert.doesNotMatch(loadOverviewSource, /throw metricsResult\.reason/);
  assert.doesNotMatch(loadOverviewSource, /setOriginData\(EMPTY_ORIGIN_DATA\)/);
  assert.doesNotMatch(loadOverviewSource, /setDetectedPhones\(\[\]\)/);
});
