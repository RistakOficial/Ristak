import { BarChart3, CalendarDays, CreditCard, MessageCircle, Settings, type LucideIcon } from 'lucide-react'

export type PhoneSection = 'chat' | 'calendar' | 'payments' | 'analytics' | 'settings'
export type PhoneRouteDirection = 'forward' | 'back' | 'none'

export interface PhoneNavItem {
  key: PhoneSection
  label: string
  to: string
  Icon: LucideIcon
}

export const PHONE_NAV_ITEMS: PhoneNavItem[] = [
  { key: 'chat', label: 'Chats', to: '/phone/chat', Icon: MessageCircle },
  { key: 'calendar', label: 'Citas', to: '/phone/calendar', Icon: CalendarDays },
  { key: 'payments', label: 'Pagos', to: '/phone/payments', Icon: CreditCard },
  { key: 'analytics', label: 'Analíticas', to: '/phone/analytics', Icon: BarChart3 },
  { key: 'settings', label: 'Ajustes', to: '/phone/settings', Icon: Settings }
]

export const PHONE_NAV_ACTIVE_INDEX_KEY = 'ristak_phone_nav_active_index'
export const PHONE_NAV_TRANSITION_DIRECTION_KEY = 'ristak_phone_nav_transition_direction'
export const PHONE_NAV_TRANSITION_TARGET_KEY = 'ristak_phone_nav_transition_target_index'
export const PHONE_NAV_ROUTE_INDEX_KEY = 'ristak_phone_route_transition_index'

export function clampPhoneNavIndex(index: number) {
  return Number.isFinite(index) ? Math.min(Math.max(index, 0), PHONE_NAV_ITEMS.length - 1) : 0
}

export function getPhoneSectionIndex(section: PhoneSection) {
  return clampPhoneNavIndex(PHONE_NAV_ITEMS.findIndex((item) => item.key === section))
}

export function getPhoneRouteDirection(fromIndex: number, toIndex: number): PhoneRouteDirection {
  if (fromIndex === toIndex) return 'none'
  return fromIndex < toIndex ? 'forward' : 'back'
}

export function readStoredPhoneNavIndex(fallback: number) {
  if (typeof window === 'undefined') return fallback
  const storedIndex = Number(window.sessionStorage.getItem(PHONE_NAV_ACTIVE_INDEX_KEY))
  return Number.isFinite(storedIndex) ? clampPhoneNavIndex(storedIndex) : fallback
}

export function storePhoneNavIntent(fromIndex: number, toIndex: number) {
  if (typeof window === 'undefined' || fromIndex === toIndex) return
  window.sessionStorage.setItem(PHONE_NAV_TRANSITION_DIRECTION_KEY, getPhoneRouteDirection(fromIndex, toIndex))
  window.sessionStorage.setItem(PHONE_NAV_TRANSITION_TARGET_KEY, String(clampPhoneNavIndex(toIndex)))
}
