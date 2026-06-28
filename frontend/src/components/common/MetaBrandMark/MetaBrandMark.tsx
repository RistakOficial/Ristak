import React from 'react'

export interface MetaBrandMarkProps extends Omit<React.SVGProps<SVGSVGElement>, 'height' | 'width'> {
  size?: number
}

export const MetaBrandMark: React.FC<MetaBrandMarkProps> = ({
  size = 18,
  strokeWidth = 2.25,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel,
  ...props
}) => (
  <svg
    {...props}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden={ariaHidden ?? (ariaLabel ? undefined : true)}
    aria-label={ariaLabel}
    focusable="false"
  >
    <path
      d="M3.25 14.45c0-4.38 2.03-7.58 4.55-7.58 1.82 0 3.18 1.28 4.2 3.3 1.02-2.02 2.38-3.3 4.2-3.3 2.52 0 4.55 3.2 4.55 7.58 0 2.34-.88 3.68-2.38 3.68-1.56 0-2.72-1.36-4.28-4.08L12 10.43l-2.09 3.62c-1.56 2.72-2.72 4.08-4.28 4.08-1.5 0-2.38-1.34-2.38-3.68Z"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export default MetaBrandMark
