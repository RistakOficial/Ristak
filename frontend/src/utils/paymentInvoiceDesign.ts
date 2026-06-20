import type React from 'react'
import type { PaymentReceiptSettings } from '@/services/paymentSettingsService'

export type PaymentInvoiceTemplateId = 'classic' | 'executive' | 'accent' | 'ledger'
export type PaymentInvoicePaletteId = 'graphite' | 'sage' | 'indigo' | 'terracotta' | 'champagne' | 'custom'

export interface PaymentInvoiceTemplateOption {
  id: PaymentInvoiceTemplateId
  label: string
  description: string
}

export interface PaymentInvoicePaletteOption {
  id: Exclude<PaymentInvoicePaletteId, 'custom'>
  label: string
  accentColor: string
  paperColor: string
  textColor: string
}

export const invoiceTemplateOptions: PaymentInvoiceTemplateOption[] = [
  {
    id: 'classic',
    label: 'Clásico',
    description: 'Hoja limpia con jerarquía editorial.'
  },
  {
    id: 'executive',
    label: 'Ejecutivo',
    description: 'Cabecera sólida y datos más corporativos.'
  },
  {
    id: 'accent',
    label: 'Acento',
    description: 'Franja de color elegante para marca.'
  },
  {
    id: 'ledger',
    label: 'Ledger',
    description: 'Más contable, con líneas y totales fuertes.'
  }
]

export const invoicePaletteOptions: PaymentInvoicePaletteOption[] = [
  {
    id: 'graphite',
    label: 'Grafito',
    accentColor: '#111827',
    paperColor: '#ffffff',
    textColor: '#111827'
  },
  {
    id: 'sage',
    label: 'Sage',
    accentColor: '#2f5d50',
    paperColor: '#fbfcf8',
    textColor: '#18211e'
  },
  {
    id: 'indigo',
    label: 'Índigo',
    accentColor: '#31456f',
    paperColor: '#fbfbff',
    textColor: '#111827'
  },
  {
    id: 'terracotta',
    label: 'Terracota',
    accentColor: '#9a563f',
    paperColor: '#fffaf7',
    textColor: '#251814'
  },
  {
    id: 'champagne',
    label: 'Champagne',
    accentColor: '#b3863b',
    paperColor: '#fffdf7',
    textColor: '#211a10'
  }
]

const fallbackTemplate = invoiceTemplateOptions[0]
const fallbackPalette = invoicePaletteOptions[0]

const hexPattern = /^#[0-9a-f]{6}$/i

function normalizeHexColor(value: unknown, fallback: string) {
  const text = String(value || '').trim()
  return hexPattern.test(text) ? text : fallback
}

function hexToRgb(hex: string) {
  const normalized = normalizeHexColor(hex, '#111827').slice(1)
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  }
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }) {
  const toPart = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')
  return `#${toPart(r)}${toPart(g)}${toPart(b)}`
}

function mixHex(base: string, overlay: string, overlayAmount: number) {
  const baseRgb = hexToRgb(base)
  const overlayRgb = hexToRgb(overlay)
  const amount = Math.max(0, Math.min(1, overlayAmount))
  return rgbToHex({
    r: baseRgb.r * (1 - amount) + overlayRgb.r * amount,
    g: baseRgb.g * (1 - amount) + overlayRgb.g * amount,
    b: baseRgb.b * (1 - amount) + overlayRgb.b * amount
  })
}

function readableOnColor(hex: string) {
  const { r, g, b } = hexToRgb(hex)
  const srgb = [r, g, b].map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2]
  return luminance > 0.48 ? '#111827' : '#ffffff'
}

export function resolveInvoiceDesign(receipt?: Partial<PaymentReceiptSettings> | null) {
  const template = invoiceTemplateOptions.find((option) => option.id === receipt?.invoiceTemplate) || fallbackTemplate
  const palette = invoicePaletteOptions.find((option) => option.id === receipt?.invoicePalette) || fallbackPalette
  const accentColor = normalizeHexColor(receipt?.invoiceAccentColor, palette.accentColor)
  const paperColor = normalizeHexColor(receipt?.invoicePaperColor, palette.paperColor)
  const textColor = normalizeHexColor(receipt?.invoiceTextColor, palette.textColor)
  const softColor = mixHex(paperColor, accentColor, 0.1)
  const borderColor = mixHex(paperColor, textColor, 0.2)

  return {
    template,
    palette,
    accentColor,
    paperColor,
    textColor,
    softColor,
    borderColor,
    onAccentColor: readableOnColor(accentColor)
  }
}

export function buildInvoiceStyleVars(receipt?: Partial<PaymentReceiptSettings> | null): React.CSSProperties {
  const design = resolveInvoiceDesign(receipt)
  return {
    '--invoice-accent': design.accentColor,
    '--invoice-paper': design.paperColor,
    '--invoice-ink': design.textColor,
    '--invoice-soft': design.softColor,
    '--invoice-border': design.borderColor,
    '--invoice-on-accent': design.onAccentColor
  } as React.CSSProperties
}

