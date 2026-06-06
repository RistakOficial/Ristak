import { BarChart3, CalendarDays, CircleDollarSign, MessageCircle, Settings, type LucideIcon } from 'lucide-react'

export type PhoneSection = 'chat' | 'calendar' | 'payments' | 'analytics' | 'settings'
export type PhoneRouteDirection = 'forward' | 'back' | 'none'

export interface PhoneNavItem {
  key: PhoneSection
  label: string
  to: string
  Icon: LucideIcon
}

export const PHONE_NAV_ITEMS: PhoneNavItem[] = [
  { key: 'settings', label: 'Ajustes', to: '/phone/settings', Icon: Settings },
  { key: 'chat', label: 'Chats', to: '/phone/chat', Icon: MessageCircle },
  { key: 'calendar', label: 'Citas', to: '/phone/calendar', Icon: CalendarDays },
  { key: 'payments', label: 'Pagos', to: '/phone/payments', Icon: CircleDollarSign },
  { key: 'analytics', label: 'Analíticas', to: '/phone/analytics', Icon: BarChart3 }
]

export const PHONE_NAV_ACTIVE_INDEX_KEY = 'ristak_phone_nav_active_index'
export const PHONE_NAV_TRANSITION_DIRECTION_KEY = 'ristak_phone_nav_transition_direction'
export const PHONE_NAV_TRANSITION_TARGET_KEY = 'ristak_phone_nav_transition_target_index'
export const PHONE_NAV_TRANSITION_TARGET_SECTION_KEY = 'ristak_phone_nav_transition_target_section'
export const PHONE_NAV_ROUTE_INDEX_KEY = 'ristak_phone_route_transition_index'
export const PHONE_NAV_ROUTE_SECTION_KEY = 'ristak_phone_route_transition_section'

export function clampPhoneNavIndex(index: number) {
  return Number.isFinite(index) ? Math.min(Math.max(index, 0), PHONE_NAV_ITEMS.length - 1) : 0
}

export function getPhoneSectionIndex(section: PhoneSection) {
  return clampPhoneNavIndex(PHONE_NAV_ITEMS.findIndex((item) => item.key === section))
}

export function isPhoneSection(value?: string | null): value is PhoneSection {
  return PHONE_NAV_ITEMS.some((item) => item.key === value)
}

export function getPhoneRouteDirection(fromIndex: number, toIndex: number): PhoneRouteDirection {
  if (fromIndex === toIndex) return 'none'
  return fromIndex < toIndex ? 'forward' : 'back'
}

export function getPhoneRouteDirectionBySection(fromSection: PhoneSection, toSection: PhoneSection): PhoneRouteDirection {
  return getPhoneRouteDirection(getPhoneSectionIndex(fromSection), getPhoneSectionIndex(toSection))
}

export function readStoredPhoneNavIndex(fallback: number) {
  if (typeof window === 'undefined') return fallback
  const storedIndex = Number(window.sessionStorage.getItem(PHONE_NAV_ACTIVE_INDEX_KEY))
  return Number.isFinite(storedIndex) ? clampPhoneNavIndex(storedIndex) : fallback
}

export function storePhoneNavIntent(fromSection: PhoneSection, toSection: PhoneSection) {
  if (typeof window === 'undefined' || fromSection === toSection) return
  const toIndex = getPhoneSectionIndex(toSection)
  window.sessionStorage.setItem(PHONE_NAV_TRANSITION_DIRECTION_KEY, getPhoneRouteDirectionBySection(fromSection, toSection))
  window.sessionStorage.setItem(PHONE_NAV_TRANSITION_TARGET_KEY, String(toIndex))
  window.sessionStorage.setItem(PHONE_NAV_TRANSITION_TARGET_SECTION_KEY, toSection)
}
