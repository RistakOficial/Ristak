import { calculatePaymentTax } from './paymentSettingsService.js'

const PREVIEW_AMOUNT = 2490
const PREVIEW_REFERENCE = 'PAY-1048'

const paletteOptions = [
  { id: 'graphite', accentColor: '#111827', paperColor: '#ffffff', textColor: '#111827' },
  { id: 'sage', accentColor: '#2f5d50', paperColor: '#fbfcf8', textColor: '#18211e' },
  { id: 'indigo', accentColor: '#31456f', paperColor: '#fbfbff', textColor: '#111827' },
  { id: 'terracotta', accentColor: '#9a563f', paperColor: '#fffaf7', textColor: '#251814' },
  { id: 'champagne', accentColor: '#b3863b', paperColor: '#fffdf7', textColor: '#211a10' }
]

const fallbackPalette = paletteOptions[0]
const hexPattern = /^#[0-9a-f]{6}$/i

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;')
}

function cleanCurrency(value) {
  const normalized = String(value || 'MXN').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(normalized) ? normalized : 'MXN'
}

function cleanTemplate(value) {
  return ['classic', 'executive', 'accent', 'ledger'].includes(value) ? value : 'classic'
}

function cleanImageUrl(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.startsWith('/') && !text.startsWith('//')) return text
  if (/^https?:\/\//i.test(text)) return text
  return ''
}

function normalizeHexColor(value, fallback) {
  const text = String(value || '').trim()
  return hexPattern.test(text) ? text : fallback
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex, '#111827').slice(1)
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  }
}

function rgbToHex({ r, g, b }) {
  const toPart = (value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')
  return `#${toPart(r)}${toPart(g)}${toPart(b)}`
}

function mixHex(base, overlay, overlayAmount) {
  const baseRgb = hexToRgb(base)
  const overlayRgb = hexToRgb(overlay)
  const amount = Math.max(0, Math.min(1, overlayAmount))
  return rgbToHex({
    r: baseRgb.r * (1 - amount) + overlayRgb.r * amount,
    g: baseRgb.g * (1 - amount) + overlayRgb.g * amount,
    b: baseRgb.b * (1 - amount) + overlayRgb.b * amount
  })
}

function readableOnColor(hex) {
  const { r, g, b } = hexToRgb(hex)
  const srgb = [r, g, b].map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2]
  return luminance > 0.48 ? '#111827' : '#ffffff'
}

function resolveReceiptDesign(receipt = {}) {
  const palette = paletteOptions.find((option) => option.id === receipt.invoicePalette) || fallbackPalette
  const accentColor = normalizeHexColor(receipt.invoiceAccentColor, palette.accentColor)
  const paperColor = normalizeHexColor(receipt.invoicePaperColor, palette.paperColor)
  const textColor = normalizeHexColor(receipt.invoiceTextColor, palette.textColor)

  return {
    template: cleanTemplate(receipt.invoiceTemplate),
    accentColor,
    paperColor,
    textColor,
    softColor: mixHex(paperColor, accentColor, 0.1),
    borderColor: mixHex(paperColor, textColor, 0.2),
    onAccentColor: readableOnColor(accentColor)
  }
}

function formatMoney(value, currency = 'MXN') {
  const amount = Number(value)
  const safeAmount = Number.isFinite(amount) ? amount : 0
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: cleanCurrency(currency),
      maximumFractionDigits: 0
    }).format(safeAmount)
  } catch {
    return `$${Math.round(safeAmount).toLocaleString('es-MX')}`
  }
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date)
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function renderTextBlock(tagName, className, value) {
  const text = String(value || '').trim()
  return text ? `<${tagName} class="${className}">${escapeHtml(text)}</${tagName}>` : ''
}

function renderBusinessInfo(receipt) {
  if (receipt.showBusinessInfo === false) return ''

  return `
    <div>
      <span>Emitido por</span>
      <strong>${escapeHtml(receipt.businessName || 'Tu negocio')}</strong>
      ${receipt.businessEmail ? `<p>${escapeHtml(receipt.businessEmail)}</p>` : ''}
      ${receipt.businessPhone ? `<p>${escapeHtml(receipt.businessPhone)}</p>` : ''}
      ${receipt.businessAddress ? `<p>${escapeHtml(receipt.businessAddress)}</p>` : ''}
    </div>
  `
}

function renderCustomerInfo(receipt) {
  if (receipt.showCustomerInfo === false) return ''

  return `
    <div>
      <span>Cliente</span>
      <strong>María López</strong>
      <p>maria@cliente.com</p>
      <p>Referencia ${PREVIEW_REFERENCE}</p>
    </div>
  `
}

function renderTerms(receipt) {
  if (receipt.showTerms === false) return ''

  return `
    <section class="terms">
      <strong>Términos y condiciones</strong>
      <p>${escapeHtml(receipt.terms || 'Agrega aquí políticas de pago, reembolso, emisión de comprobantes o condiciones del servicio.')}</p>
    </section>
  `
}

function buildSheetStyle(design) {
  return [
    `--invoice-accent:${design.accentColor}`,
    `--invoice-paper:${design.paperColor}`,
    `--invoice-ink:${design.textColor}`,
    `--invoice-soft:${design.softColor}`,
    `--invoice-border:${design.borderColor}`,
    `--invoice-on-accent:${design.onAccentColor}`
  ].join(';')
}

function getInitial(text) {
  const normalized = String(text || 'R').trim()
  return escapeHtml((normalized[0] || 'R').toUpperCase())
}

export function renderPaymentReceiptPreviewHtml(settings, options = {}) {
  const receipt = settings?.receipt || {}
  const checkout = settings?.checkout || {}
  const currency = cleanCurrency(options.currency)
  const generatedAt = options.generatedAt instanceof Date ? options.generatedAt : new Date()
  const dueDate = addDays(generatedAt, 18)
  const taxDetails = calculatePaymentTax(PREVIEW_AMOUNT, settings?.taxes || {}, { provider: 'stripe' })
  const hasTaxBreakdown = Boolean(taxDetails?.enabled && taxDetails.taxAmount > 0)
  const subtotalAmount = hasTaxBreakdown ? taxDetails.subtotalAmount : PREVIEW_AMOUNT
  const taxAmount = hasTaxBreakdown ? taxDetails.taxAmount : 0
  const totalAmount = hasTaxBreakdown ? taxDetails.totalAmount : PREVIEW_AMOUNT
  const design = resolveReceiptDesign(receipt)
  const logoUrl = cleanImageUrl(receipt.logoUrl || checkout.logoUrl)
  const businessName = receipt.businessName || 'Tu negocio'
  const businessContact = receipt.businessWebsite || receipt.businessEmail || 'tu-negocio.com'
  const title = receipt.title || 'Comprobante de pago'
  const templateClass = `theme-${design.template}`
  const sheetStyle = buildSheetStyle(design)

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Vista previa del comprobante</title>
    <style>
      * { box-sizing: border-box; }
      html { color-scheme: light; }
      body {
        margin: 0;
        background: #eef2f7;
        color: #182033;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .toolbar {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px clamp(16px, 4vw, 32px);
        border-bottom: 1px solid rgba(24, 32, 51, 0.12);
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(12px);
      }
      .toolbar span {
        display: block;
        color: #647087;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .toolbar h1 {
        margin: 4px 0 0;
        color: #182033;
        font-size: clamp(18px, 2.5vw, 24px);
        line-height: 1.15;
        letter-spacing: 0;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .private-badge {
        min-height: 34px;
        display: inline-flex;
        align-items: center;
        border: 1px solid rgba(24, 32, 51, 0.14);
        border-radius: 999px;
        padding: 0 12px;
        color: #526078;
        font-size: 13px;
        font-weight: 650;
        white-space: nowrap;
      }
      button {
        min-height: 38px;
        border: 0;
        border-radius: 10px;
        padding: 0 16px;
        background: #182033;
        color: #ffffff;
        font: inherit;
        font-size: 13px;
        font-weight: 750;
        cursor: pointer;
      }
      button:hover { background: #26324a; }
      .preview {
        width: min(100%, 1120px);
        margin: 0 auto;
        padding: clamp(18px, 4vw, 42px);
      }
      .sheet {
        width: min(100%, 794px);
        min-height: 1120px;
        margin: 0 auto;
        padding: clamp(28px, 5vw, 52px);
        border: 1px solid var(--invoice-border, ButtonBorder);
        border-radius: 4px;
        background: var(--invoice-paper, Canvas);
        color: var(--invoice-ink, CanvasText);
        box-shadow: 0 20px 60px rgba(24, 32, 51, 0.14);
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      .header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 24px;
        padding-bottom: 22px;
        border-bottom: 2px solid var(--invoice-accent, ButtonBorder);
      }
      .identity {
        display: flex;
        align-items: flex-start;
        gap: 14px;
        min-width: 0;
      }
      .identity img,
      .logo-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 64px;
        height: 64px;
        flex: 0 0 auto;
        border: 1px solid var(--invoice-border, ButtonBorder);
        background: var(--invoice-paper, Canvas);
        color: var(--invoice-accent, GrayText);
        object-fit: contain;
      }
      .identity img { padding: 7px; }
      .logo-mark {
        font-size: 22px;
        font-weight: 800;
      }
      .identity strong,
      .payment-meta strong,
      .parties strong {
        display: block;
        color: var(--invoice-ink, CanvasText);
        font-size: 14px;
        font-weight: 760;
        overflow-wrap: anywhere;
      }
      .identity p,
      .parties p,
      .intro,
      .description,
      .terms p,
      .footer {
        margin: 4px 0 0;
        color: var(--invoice-ink, CanvasText);
        font-size: 11px;
        line-height: 1.5;
        white-space: pre-wrap;
      }
      .meta {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 5px;
        max-width: 280px;
        text-align: right;
      }
      .meta h2 {
        margin: 0 0 4px;
        color: var(--invoice-ink, CanvasText);
        font-size: 23px;
        font-weight: 760;
        line-height: 1.12;
        letter-spacing: 0;
        overflow-wrap: anywhere;
      }
      .meta span,
      .payment-meta span,
      .parties span,
      .line-head span,
      .totals span,
      .terms strong {
        color: color-mix(in srgb, var(--invoice-ink, CanvasText) 62%, transparent);
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .intro { margin-top: 18px; }
      .payment-meta {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 9px;
        margin-top: 20px;
        break-inside: avoid;
      }
      .payment-meta > div {
        padding: 11px;
        border: 1px solid var(--invoice-border, ButtonBorder);
        background: var(--invoice-soft, Canvas);
      }
      .payment-meta strong {
        margin-top: 4px;
        font-size: 12px;
      }
      .parties {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 24px;
        margin-top: 24px;
        padding: 16px 0;
        border-top: 1px solid var(--invoice-border, ButtonBorder);
        border-bottom: 1px solid var(--invoice-border, ButtonBorder);
      }
      .lines {
        display: grid;
        margin-top: 24px;
        border: 1px solid var(--invoice-border, ButtonBorder);
        break-inside: avoid;
      }
      .line-head,
      .line-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 56px 126px;
        gap: 12px;
        align-items: center;
      }
      .line-head {
        padding: 10px 12px;
        border-bottom: 1px solid var(--invoice-border, ButtonBorder);
        background: var(--invoice-soft, Canvas);
      }
      .line-row { padding: 15px 12px; }
      .line-row strong,
      .line-row span,
      .totals strong {
        color: var(--invoice-ink, CanvasText);
        font-size: 12px;
        font-weight: 650;
        overflow-wrap: anywhere;
      }
      .line-head span:nth-child(2),
      .line-head span:nth-child(3),
      .line-row span:nth-child(2),
      .line-row span:nth-child(3) { text-align: right; }
      .description {
        margin: 0;
        padding: 0 12px 13px;
      }
      .totals {
        display: grid;
        gap: 8px;
        width: min(100%, 286px);
        margin: 20px 0 0 auto;
        break-inside: avoid;
      }
      .totals > div {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--invoice-border, ButtonBorder);
      }
      .totals > div:last-child {
        border-bottom: 2px solid var(--invoice-accent, ButtonBorder);
      }
      .totals > div:last-child strong {
        font-size: 15px;
        font-weight: 800;
      }
      .terms {
        margin-top: 26px;
        padding-top: 14px;
        border-top: 1px solid var(--invoice-border, ButtonBorder);
        break-inside: auto;
      }
      .footer {
        margin-top: 22px;
        padding-top: 12px;
        border-top: 1px solid var(--invoice-border, ButtonBorder);
        font-weight: 650;
      }
      .theme-classic { border-top: 5px solid var(--invoice-accent); }
      .theme-executive { border-radius: 7px; }
      .theme-executive .header {
        padding: 20px;
        border: 1px solid var(--invoice-border);
        background: var(--invoice-soft);
      }
      .theme-accent {
        overflow: hidden;
        border-color: var(--invoice-accent);
      }
      .theme-accent .header {
        margin: calc(-1 * clamp(28px, 5vw, 52px)) calc(-1 * clamp(28px, 5vw, 52px)) 24px;
        padding: clamp(28px, 5vw, 52px);
        border-bottom: 0;
        background: var(--invoice-accent);
        color: var(--invoice-on-accent);
      }
      .theme-accent .identity img,
      .theme-accent .logo-mark {
        border-color: color-mix(in srgb, var(--invoice-on-accent) 48%, transparent);
        background: color-mix(in srgb, var(--invoice-on-accent) 10%, transparent);
        color: var(--invoice-on-accent);
      }
      .theme-accent .identity strong,
      .theme-accent .identity p,
      .theme-accent .meta h2,
      .theme-accent .meta span { color: var(--invoice-on-accent); }
      .theme-accent .line-head { background: var(--invoice-accent); }
      .theme-accent .line-head span { color: var(--invoice-on-accent); }
      .theme-ledger {
        border-radius: 0;
        border-top: 2px solid var(--invoice-accent);
        box-shadow: 0 20px 60px rgba(24, 32, 51, 0.11);
      }
      .theme-ledger .payment-meta > div,
      .theme-ledger .lines {
        background-image: linear-gradient(var(--invoice-border), var(--invoice-border));
        background-size: 100% 1px;
        background-repeat: no-repeat;
        background-position: bottom left;
      }
      @media (max-width: 720px) {
        .toolbar {
          position: static;
          align-items: stretch;
          flex-direction: column;
        }
        .actions { justify-content: flex-start; }
        .header,
        .parties {
          grid-template-columns: 1fr;
          flex-direction: column;
        }
        .meta {
          align-items: flex-start;
          max-width: none;
          text-align: left;
        }
        .payment-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .line-head,
        .line-row { grid-template-columns: minmax(0, 1fr) 42px 96px; }
      }
      @page { size: A4; margin: 14mm; }
      @media print {
        body {
          background: #ffffff;
          color: #000000;
        }
        .toolbar { display: none; }
        .preview {
          width: 100%;
          padding: 0;
        }
        .sheet {
          width: 100%;
          min-height: auto;
          margin: 0;
          padding: 0;
          border: 0;
          border-top: 5px solid var(--invoice-accent, ButtonBorder);
          border-radius: 0;
          box-shadow: none;
        }
        .theme-executive,
        .theme-accent {
          border-top: 0;
        }
        .theme-accent .header {
          margin: 0 0 20px;
          padding: 24px;
        }
        button { display: none; }
      }
    </style>
  </head>
  <body>
    <header class="toolbar">
      <div>
        <span>Vista previa privada</span>
        <h1>Comprobante de pago descargable</h1>
      </div>
      <div class="actions">
        <div class="private-badge">Solo con tu sesión</div>
        <button type="button" data-download-pdf>Descargar PDF de prueba</button>
      </div>
    </header>

    <main class="preview">
      <section class="sheet ${templateClass}" style="${sheetStyle}" aria-label="Vista previa del comprobante de pago descargable">
        <header class="header">
          <div class="identity">
            ${logoUrl ? `<img src="${escapeAttribute(logoUrl)}" alt="" />` : `<span class="logo-mark">${getInitial(businessName)}</span>`}
            <div>
              <strong>${escapeHtml(businessName)}</strong>
              <p>${escapeHtml(businessContact)}</p>
            </div>
          </div>
          <div class="meta">
            <h2>${escapeHtml(title)}</h2>
            <span>Referencia ${PREVIEW_REFERENCE}</span>
            <span>Fecha de pago ${escapeHtml(formatDate(generatedAt))}</span>
          </div>
        </header>

        ${renderTextBlock('p', 'intro', receipt.intro)}

        <section class="payment-meta" aria-label="Datos del pago">
          <div>
            <span>Estado</span>
            <strong>Pagado</strong>
          </div>
          <div>
            <span>Fecha de pago</span>
            <strong>${escapeHtml(formatDate(generatedAt))}</strong>
          </div>
          <div>
            <span>Vencimiento</span>
            <strong>${escapeHtml(formatDate(dueDate))}</strong>
          </div>
          <div>
            <span>Pasarela</span>
            <strong>Stripe · Prueba</strong>
          </div>
        </section>

        <section class="parties">
          ${renderBusinessInfo(receipt)}
          ${renderCustomerInfo(receipt)}
        </section>

        <section class="lines" aria-label="Detalle del pago">
          <div class="line-head">
            <span>Concepto</span>
            <span>Cant.</span>
            <span>Importe</span>
          </div>
          <div class="line-row">
            <strong>Plan mensual</strong>
            <span>1</span>
            <span>${escapeHtml(formatMoney(subtotalAmount, currency))}</span>
          </div>
          <p class="description">Pago de prueba para revisar cómo se verá el comprobante descargable.</p>
        </section>

        <section class="totals" aria-label="Totales">
          <div>
            <span>Subtotal</span>
            <strong>${escapeHtml(formatMoney(subtotalAmount, currency))}</strong>
          </div>
          ${hasTaxBreakdown ? `
            <div>
              <span>${escapeHtml(taxDetails.calculationMode === 'inclusive' ? `${taxDetails.taxName || 'Impuesto'} incluido` : taxDetails.taxName || 'Impuesto')}</span>
              <strong>${escapeHtml(formatMoney(taxAmount, currency))}</strong>
            </div>
          ` : ''}
          <div>
            <span>Total pagado</span>
            <strong>${escapeHtml(formatMoney(totalAmount, currency))}</strong>
          </div>
        </section>

        ${renderTerms(receipt)}
        ${renderTextBlock('p', 'footer', receipt.footer)}
      </section>
    </main>

    <script>
      (() => {
        const button = document.querySelector('[data-download-pdf]');
        if (!button) return;
        button.addEventListener('click', () => {
          const previousTitle = document.title;
          document.title = 'comprobante-prueba-${PREVIEW_REFERENCE}';
          window.requestAnimationFrame(() => {
            window.print();
            window.setTimeout(() => {
              document.title = previousTitle;
            }, 500);
          });
        });
      })();
    </script>
  </body>
</html>`
}
