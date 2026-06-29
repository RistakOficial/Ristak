export const suppressBrowserAutofill = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'none',
  spellCheck: false,
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-form-type': 'other'
} as const

export const suppressContactAutofill = {
  ...suppressBrowserAutofill,
  autoComplete: 'new-password'
} as const
