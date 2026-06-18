interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
  className?: string
}

export function Switch({
  checked,
  onChange,
  disabled,
  id,
  'aria-label': ariaLabel,
  className,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-label={ariaLabel}
      aria-checked={checked}
      data-sw
      data-on={checked ? 'true' : undefined}
      disabled={disabled}
      className={className}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="knob" />
    </button>
  )
}
