import React, { forwardRef, useId } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { suppressBrowserAutofill } from '@/utils/browserAutofill'
import styles from './SearchField.module.css'

export interface SearchFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size' | 'type'> {
  value: string
  onChange: (value: string, event: React.ChangeEvent<HTMLInputElement>) => void
  onClear?: () => void
  clearLabel?: string
  loading?: boolean
  showClear?: boolean
  size?: 'sm' | 'md'
  inputClassName?: string
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(({
  value,
  onChange,
  onClear,
  clearLabel = 'Limpiar búsqueda',
  loading = false,
  showClear = true,
  size = 'md',
  inputClassName,
  className,
  disabled,
  id,
  placeholder = 'Buscar',
  ...inputProps
}, ref) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const canClear = showClear && Boolean(value) && Boolean(onClear) && !disabled && !loading

  return (
    <div
      className={cn(styles.root, className)}
      data-ristak-unstyled
      data-ristak-search-field
      data-size={size}
      data-disabled={disabled ? 'true' : undefined}
      data-loading={loading ? 'true' : undefined}
    >
      <Search aria-hidden="true" size={16} className={styles.icon} />
      <input
        {...suppressBrowserAutofill}
        {...inputProps}
        ref={ref}
        id={inputId}
        type="search"
        className={cn(styles.input, inputClassName)}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value, event)}
      />
      {loading ? (
        <Loader2 aria-hidden="true" size={16} className={styles.loader} />
      ) : canClear ? (
        <button
          type="button"
          className={styles.clearButton}
          onClick={onClear}
          aria-label={clearLabel}
        >
          <X aria-hidden="true" size={15} />
        </button>
      ) : null}
    </div>
  )
})

SearchField.displayName = 'SearchField'
