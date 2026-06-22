import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBottomSheetDismiss } from '@/hooks'
import styles from './PhoneSheet.module.css'

export type PhoneSheetHeight = 'auto' | 'tall' | 'full'

interface PhoneSheetProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  subtitle?: string
  headerLeft?: React.ReactNode
  headerRight?: React.ReactNode
  height?: PhoneSheetHeight
  scrollable?: boolean
  ariaLabel?: string
  panelClassName?: string
  contentClassName?: string
  children: React.ReactNode
}

type PhoneSheetCloser = (afterClose?: () => void) => void

const PhoneSheetCloseContext = createContext<PhoneSheetCloser>(() => {})

/**
 * Cierra el sheet con la animación de colapso desde cualquier componente hijo.
 * Cerrar cambiando el estado del padre (isOpen=false) también anima la salida,
 * así que este hook solo hace falta cuando quieres encadenar un afterClose.
 */
export function usePhoneSheetClose() {
  return useContext(PhoneSheetCloseContext)
}

const EXIT_DURATION_MS = 260

/**
 * Bottom sheet estándar de la app móvil: backdrop sombreado, asa de arrastre,
 * gesto para descartar y colapso suave SIEMPRE (incluso si el padre lo cierra
 * cambiando estado en vez de usar el gesto).
 */
export const PhoneSheet: React.FC<PhoneSheetProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  headerLeft,
  headerRight,
  height = 'auto',
  scrollable = true,
  ariaLabel,
  panelClassName = '',
  contentClassName = '',
  children
}) => {
  const [exiting, setExiting] = useState(false)
  const wasOpenRef = useRef(false)
  const animatedCloseRef = useRef(false)
  const dismiss = useBottomSheetDismiss({ isOpen, onClose, closeDurationMs: EXIT_DURATION_MS })
  const requestClose = dismiss.requestClose

  if (dismiss.closing) {
    animatedCloseRef.current = true
  }

  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true
      animatedCloseRef.current = false
      setExiting(false)
      return
    }

    if (!wasOpenRef.current) return
    wasOpenRef.current = false

    if (animatedCloseRef.current) {
      animatedCloseRef.current = false
      return
    }

    setExiting(true)
    const timer = window.setTimeout(() => setExiting(false), EXIT_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, requestClose])

  if (!isOpen && !exiting) return null
  if (typeof document === 'undefined') return null

  const moving = dismiss.dragging || dismiss.closing || dismiss.dragOffset > 0
  const dragging = dismiss.dragging || dismiss.dragOffset > 0
  const hasHeader = Boolean(title || subtitle || headerLeft || headerRight)

  const overlayClassName = [
    styles.overlay,
    dragging ? styles.overlayInteractive : '',
    dismiss.closing ? styles.overlayClosing : '',
    exiting ? styles.overlayExiting : ''
  ].filter(Boolean).join(' ')

  const sheetClassName = [
    styles.sheet,
    styles[height],
    moving ? styles.sheetInteractive : '',
    exiting ? styles.sheetExiting : '',
    panelClassName
  ].filter(Boolean).join(' ')

  const sheet = (
    <div
      className={overlayClassName}
      style={dismiss.backdropStyle}
      role="presentation"
      onClick={() => requestClose()}
    >
      <div
        className={sheetClassName}
        style={dismiss.sheetStyle}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel || title || 'Panel'}
        onClick={(event) => event.stopPropagation()}
        {...dismiss.sheetDragProps}
      >
        <div className={styles.handle} aria-hidden="true" />
        {hasHeader && (
          <div className={styles.header}>
            <span className={styles.headerSide}>{headerLeft}</span>
            <div className={styles.headerText}>
              {subtitle && <p>{subtitle}</p>}
              {title && <strong>{title}</strong>}
            </div>
            <span className={`${styles.headerSide} ${styles.headerSideEnd}`}>{headerRight}</span>
          </div>
        )}
        <div
          className={`${scrollable ? styles.contentScrollable : styles.content} ${contentClassName}`.trim()}
          data-bottom-sheet-no-drag={scrollable ? 'true' : undefined}
          data-bottom-sheet-scrollable={scrollable ? 'true' : undefined}
          data-phone-scrollable={scrollable ? 'true' : undefined}
        >
          <PhoneSheetCloseContext.Provider value={requestClose}>
            {children}
          </PhoneSheetCloseContext.Provider>
        </div>
      </div>
    </div>
  )

  return createPortal(sheet, document.body)
}
