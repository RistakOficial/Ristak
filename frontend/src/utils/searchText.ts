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

export const searchTextIncludes = (value: unknown, query: unknown): boolean => {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return true

  const normalizedValue = normalizeSearchValue(value)
  if (!normalizedValue) return false

  if (normalizedValue.includes(normalizedQuery)) return true

  const queryDigits = normalizeDigits(query)
  if (queryDigits.length >= 3 && normalizeDigits(value).includes(queryDigits)) {
    return true
  }

  const tokens = getSearchTokens(query).filter(token => token.length >= 2)
  if (tokens.length < 2) return false

  return tokens.every(token => normalizedValue.includes(token))
}

export const someSearchTextIncludes = (values: unknown[], query: unknown): boolean => {
  return values.some(value => searchTextIncludes(value, query))
}
