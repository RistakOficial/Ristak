import { createHash } from 'node:crypto'

export function computeImportedSiteCodeRevision(files = []) {
  const hash = createHash('sha256')
  const orderedFiles = Array.isArray(files) ? [...files] : []
  orderedFiles.sort((left, right) => String(left?.path || '').localeCompare(String(right?.path || '')))

  for (const file of orderedFiles) {
    const path = String(file?.path || '')
    const content = String(file?.content || '')
    hash.update(String(Buffer.byteLength(path, 'utf8')))
    hash.update(':')
    hash.update(path)
    hash.update(':')
    hash.update(String(Buffer.byteLength(content, 'utf8')))
    hash.update(':')
    hash.update(content)
    hash.update('\n')
  }

  return `sha256:${hash.digest('hex')}`
}

export default computeImportedSiteCodeRevision
