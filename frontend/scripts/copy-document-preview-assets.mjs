import { cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Serve PDF fonts, character maps and decoders from this installation, not a third-party viewer.
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  const source = fileURLToPath(new URL(`../node_modules/pdfjs-dist/${directory}/`, import.meta.url))
  const target = fileURLToPath(new URL(`../public/pdfjs/${directory}/`, import.meta.url))
  await mkdir(target, { recursive: true })
  await cp(source, target, { recursive: true })
}
