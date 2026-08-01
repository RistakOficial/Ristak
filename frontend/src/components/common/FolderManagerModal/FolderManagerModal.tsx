import React, { useEffect, useState } from 'react'
import { Folder, FolderPlus, Trash2 } from 'lucide-react'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Modal } from '../Modal'
import styles from './FolderManagerModal.module.css'

export interface ManagedFolder {
  id: string
  name: string
  description?: string
  count: number
}

export interface FolderManagerModalProps {
  isOpen: boolean
  title: string
  subtitle?: string
  folders: ManagedFolder[]
  itemLabel: string
  onClose: () => void
  onCreate: (input: { name: string; description?: string }) => Promise<boolean>
  onDelete: (folder: ManagedFolder) => void
}

export const FolderManagerModal: React.FC<FolderManagerModalProps> = ({
  isOpen,
  title,
  subtitle,
  folders,
  itemLabel,
  onClose,
  onCreate,
  onDelete
}) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isOpen) {
      setName('')
      setDescription('')
      setSaving(false)
    }
  }, [isOpen])

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const cleanName = name.trim()
    if (!cleanName || saving) return

    setSaving(true)
    try {
      const created = await onCreate({
        name: cleanName,
        description: description.trim() || undefined
      })
      if (created) {
        setName('')
        setDescription('')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size="md"
      contentClassName={styles.content}
      closeOnBackdropClick={!saving}
      closeOnEscape={!saving}
    >
      <form className={styles.createForm} onSubmit={handleCreate}>
        <label className={styles.field}>
          <span>Nombre</span>
          <input
            value={name}
            placeholder="Ej. Ventas"
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
            autoFocus
          />
        </label>
        <label className={styles.field}>
          <span>Descripción opcional</span>
          <input
            value={description}
            placeholder="Qué tipo de campos van aquí"
            onChange={(event) => setDescription(event.target.value)}
            disabled={saving}
          />
        </label>
        <Button
          type="submit"
          size="sm"
          loading={saving}
          disabled={!name.trim()}
          leftIcon={<FolderPlus size={16} aria-hidden="true" />}
        >
          Crear carpeta
        </Button>
      </form>

      <div className={styles.folderSection}>
        <div className={styles.sectionHeading}>
          <span>Carpetas activas</span>
          <span>{folders.length}</span>
        </div>
        {folders.length === 0 ? (
          <p className={styles.empty}>Todavía no hay carpetas. Crea la primera arriba.</p>
        ) : (
          <div className={styles.folderList}>
            {folders.map(folder => (
              <div key={folder.id} className={styles.folderRow}>
                <Folder size={17} aria-hidden="true" />
                <span className={styles.folderCopy}>
                  <span>{folder.name}</span>
                  {folder.description && <small>{folder.description}</small>}
                </span>
                <Badge variant="neutral">{folder.count} {folder.count === 1 ? itemLabel : `${itemLabel}s`}</Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Eliminar carpeta ${folder.name}`}
                  title="Eliminar carpeta"
                  onClick={() => onDelete(folder)}
                  disabled={saving}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
