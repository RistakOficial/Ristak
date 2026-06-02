const COMBINING_MARKS_PATTERN = /[\u0300-\u036f]/g

const SPECIAL_CHARACTER_REPLACEMENTS: Record<string, string> = {
  æ: 'ae',
  ø: 'o',
  œ: 'oe',
  ß: 'ss',
  đ: 'd',
  ð: 'd',
  ħ: 'h',
  ł: 'l',
  þ: 'th'
}

const SPECIAL_CHARACTER_PATTERN = /[æøœßđðħłþ]/g
const SEARCH_TOKEN_PATTERN = /[a-z0-9@._+-]+/g

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return Object.prototype.toString.call(value) === '[object Object]'
}

export const normalizeSearchText = (value: unknown): string => {
  return String(value ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS_PATTERN, '')
    .toLowerCase()
    .replace(SPECIAL_CHARACTER_PATTERN, character => SPECIAL_CHARACTER_REPLACEMENTS[character] || character)
    .replace(/\s+/g, ' ')
    .trim()
}

export const getSearchTokens = (value: unknown): string[] => {
  return normalizeSearchText(value)
    .match(SEARCH_TOKEN_PATTERN)
    ?.filter(Boolean) ?? []
}

const normalizeSearchValue = (value: unknown): string => {
  if (Array.isArray(value) || isPlainObject(value)) {
    return ''
  }

  return normalizeSearchText(value)
}

const normalizeDigits = (value: unknown): string => {
  return String(value ?? '').replace(/\D/g, '')
}

export interface PreparedSearchQuery {
  normalized: string
  digits: string
  tokens: string[]
}

export interface SearchIndex {
  text: string
  digits: string
}

export const prepareSearchQuery = (query: unknown): PreparedSearchQuery => {
  return {
    normalized: normalizeSearchText(query),
    digits: normalizeDigits(query),
    tokens: getSearchTokens(query).filter(token => token.length >= 2)
  }
}

const flattenSearchValues = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value.flatMap(flattenSearchValues)
  }

  return [value]
}

export const buildSearchIndex = (values: unknown | unknown[]): SearchIndex => {
  const parts = flattenSearchValues(values)
    .filter(value => !Array.isArray(value) && !isPlainObject(value))

  return {
    text: parts
      .map(value => normalizeSearchText(value))
      .filter(Boolean)
      .join(' '),
    digits: parts
      .map(value => normalizeDigits(value))
      .filter(Boolean)
      .join(' ')
  }
}

export const searchIndexIncludes = (
  index: SearchIndex,
  query: unknown | PreparedSearchQuery
): boolean => {
  const prepared = typeof query === 'object' && query !== null && 'normalized' in query
    ? query as PreparedSearchQuery
    : prepareSearchQuery(query)

  if (!prepared.normalized) return true
  if (!index.text && !index.digits) return false
  if (index.text.includes(prepared.normalized)) return true

  if (prepared.digits.length >= 3 && index.digits.includes(prepared.digits)) {
    return true
  }

  if (prepared.tokens.length < 2) return false

  return prepared.tokens.every(token => index.text.includes(token))
}

export const searchTextIncludes = (value: unknown, query: unknown): boolean => {
  return searchIndexIncludes(buildSearchIndex(normalizeSearchValue(value)), query)
}

export const someSearchTextIncludes = (values: unknown[], query: unknown): boolean => {
  return searchIndexIncludes(buildSearchIndex(values), query)
}
