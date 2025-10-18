import { clsx, type ClassValue } from 'clsx'

/**
 * Combina clases CSS usando clsx
 * Nota: Se eliminó tailwind-merge porque este proyecto usa CSS Modules, no Tailwind
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}
