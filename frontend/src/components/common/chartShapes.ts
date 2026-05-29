export const DEFAULT_BAR_RADIUS = 8

export function getTopRoundedBarPath(
  rawX: number,
  rawY: number,
  rawWidth: number,
  rawHeight: number,
  radius = DEFAULT_BAR_RADIUS
) {
  const x = Number(rawX)
  const y = Number(rawY)
  const width = Number(rawWidth)
  const height = Number(rawHeight)

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return ''
  }

  const right = x + width
  const bottom = y + height
  const r = Math.max(0, Math.min(radius, width / 2, height))

  if (r === 0) {
    return `M ${x} ${y} H ${right} V ${bottom} H ${x} Z`
  }

  return [
    `M ${x} ${bottom}`,
    `L ${x} ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    `H ${right - r}`,
    `Q ${right} ${y} ${right} ${y + r}`,
    `L ${right} ${bottom}`,
    'Z'
  ].join(' ')
}
