import React, { useEffect, useId, useRef, useState } from 'react'
import { Image, ImageUp, Trash2 } from 'lucide-react'
import { Button } from '../Button'
import styles from './ImageUploadField.module.css'

export interface ImageUploadFieldProps {
  label: string
  description: string
  value?: string
  onFileSelect: (file: File) => void
  onRemove?: () => void
  onUrlChange?: (value: string) => void
  helperText?: string
  previewAlt?: string
  fallbackText?: string
  chooseLabel?: string
  removeLabel?: string
  urlLabel?: string
  urlPlaceholder?: string
  accept?: string
  disabled?: boolean
  loading?: boolean
  objectFit?: 'cover' | 'contain'
  id?: string
}

export const ImageUploadField: React.FC<ImageUploadFieldProps> = ({
  label,
  description,
  value = '',
  onFileSelect,
  onRemove,
  onUrlChange,
  helperText,
  previewAlt = '',
  fallbackText = '',
  chooseLabel = 'Elegir imagen',
  removeLabel = 'Quitar',
  urlLabel = 'URL de imagen',
  urlPlaceholder = 'https://tu-dominio.com/imagen.png',
  accept = 'image/png,image/jpeg,image/webp,image/avif',
  disabled = false,
  loading = false,
  objectFit = 'cover',
  id
}) => {
  const generatedId = useId()
  const inputId = id || `image-upload-${generatedId}`
  const descriptionId = `${inputId}-description`
  const urlInputId = `${inputId}-url`
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const normalizedValue = value.trim()
  const isPendingLocalImage = /^data:image\//i.test(normalizedValue)

  useEffect(() => {
    setPreviewFailed(false)
  }, [normalizedValue])

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) onFileSelect(file)
  }

  return (
    <div className={styles.field}>
      <div className={styles.heading}>
        <label className={styles.label} htmlFor={inputId}>{label}</label>
        <p className={styles.description} id={descriptionId}>{description}</p>
      </div>

      <div className={styles.control}>
        <div className={styles.preview} data-fit={objectFit}>
          {normalizedValue && !previewFailed ? (
            <img
              key={normalizedValue}
              src={normalizedValue}
              alt={previewAlt}
              onError={() => setPreviewFailed(true)}
            />
          ) : fallbackText ? (
            <span className={styles.fallbackText}>{fallbackText.slice(0, 1).toUpperCase()}</span>
          ) : (
            <Image size={24} aria-hidden="true" />
          )}
        </div>

        <div className={styles.content}>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || loading}
            >
              <ImageUp size={15} aria-hidden="true" />
              {loading ? 'Procesando…' : chooseLabel}
            </Button>
            {normalizedValue && onRemove && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRemove}
                disabled={disabled || loading}
              >
                <Trash2 size={15} aria-hidden="true" />
                {removeLabel}
              </Button>
            )}
          </div>

          <input
            ref={fileInputRef}
            id={inputId}
            className={styles.fileInput}
            type="file"
            accept={accept}
            onChange={handleFileChange}
            aria-describedby={descriptionId}
            disabled={disabled || loading}
          />

          {helperText && <small className={styles.helper}>{helperText}</small>}
          {isPendingLocalImage && (
            <small className={styles.pending}>La imagen se subirá a Media cuando guardes los cambios.</small>
          )}

          {onUrlChange && !isPendingLocalImage && (
            <label className={styles.urlField} htmlFor={urlInputId}>
              <span>{urlLabel}</span>
              <input
                id={urlInputId}
                type="url"
                value={normalizedValue}
                onChange={(event) => onUrlChange(event.currentTarget.value)}
                placeholder={urlPlaceholder}
                disabled={disabled || loading}
              />
            </label>
          )}
        </div>
      </div>
    </div>
  )
}
