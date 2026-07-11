import React, { useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { Button } from '../Button'
import { Modal } from '../Modal'
import styles from './ExpandableTextareaField.module.css'

export interface ExpandableTextareaFieldProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'value' | 'onChange'> {
  id: string
  label: string
  description: string
  value: string
  onChange: (value: string) => void
  expandedTitle?: string
  onExpandedClose?: () => void
}

export const ExpandableTextareaField: React.FC<ExpandableTextareaFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  expandedTitle,
  onExpandedClose,
  rows = 8,
  placeholder,
  onBlur,
  ...textareaProps
}) => {
  const [expanded, setExpanded] = useState(false)
  const expandButtonRef = useRef<HTMLButtonElement>(null)
  const descriptionId = `${id}-description`
  const characterCount = value.length.toLocaleString('es-MX')

  const closeExpanded = () => {
    setExpanded(false)
    onExpandedClose?.()
    window.requestAnimationFrame(() => expandButtonRef.current?.focus())
  }

  const sharedTextareaProps = {
    ...textareaProps,
    value,
    placeholder,
    'aria-describedby': descriptionId,
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange(event.currentTarget.value),
    onBlur
  }

  return (
    <div className={styles.field}>
      <div className={styles.heading}>
        <div className={styles.copy}>
          <label className={styles.label} htmlFor={id}>{label}</label>
          <p className={styles.description} id={descriptionId}>{description}</p>
        </div>
        <Button
          ref={expandButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          className={styles.expandAction}
          aria-label={`Expandir ${label.toLowerCase()}`}
          title="Expandir editor"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 size={17} />
        </Button>
      </div>

      <textarea
        {...sharedTextareaProps}
        id={id}
        rows={rows}
        className={styles.compactEditor}
      />
      <div className={styles.meta}>
        <span>{characterCount} caracteres</span>
        <span>El texto se guarda completo</span>
      </div>

      <Modal
        isOpen={expanded}
        onClose={closeExpanded}
        title={expandedTitle || `Editar ${label.toLowerCase()}`}
        subtitle={description}
        size="xl"
        type="custom"
        closeAriaLabel={`Cerrar editor de ${label.toLowerCase()}`}
        contentClassName={styles.focusContent}
      >
        <div className={styles.focusBody}>
          <textarea
            {...sharedTextareaProps}
            className={styles.focusEditor}
            aria-label={label}
            data-ristak-unstyled=""
            autoFocus
          />
          <div className={styles.meta}>
            <span>{characterCount} caracteres</span>
            <span>Cierra cuando termines; no se pierde lo escrito</span>
          </div>
        </div>
      </Modal>
    </div>
  )
}
