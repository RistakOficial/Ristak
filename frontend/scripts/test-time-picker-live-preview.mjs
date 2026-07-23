import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../src/components/common/TimePickerSelect/TimePickerSelect.tsx', import.meta.url),
  'utf8'
)

assert.match(
  source,
  /const draftValue = timePartsToValue\(draft\)/,
  'el selector debe componer la hora temporal mientras el menú está abierto'
)
assert.match(
  source,
  /formatTimeValue\(open \? draftValue : value\)/,
  'el control debe mostrar la hora temporal antes de confirmarla'
)
assert.match(
  source,
  /aria-live="polite"[\s\S]*Horario seleccionado[\s\S]*formatTimeValue\(draftValue\)/,
  'el dropdown debe mostrar y anunciar el preview de la hora temporal'
)
assert.equal(
  source.match(/onValueChange\(/g)?.length,
  1,
  'el valor confirmado sólo debe emitirse desde De acuerdo'
)
assert.match(
  source,
  /if \(nextOpen\) setDraft\(parseTimeParts\(value\)\)/,
  'reabrir el selector debe partir del último valor confirmado'
)

console.log('Time picker live preview contract OK')
