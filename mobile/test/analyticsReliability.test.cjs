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
