import React, { useEffect, useState } from 'react'
import { Check, Lock, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button, PageHeader } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { contactTagsService, type ContactTag } from '@/services/contactTagsService'
import styles from './TagsSettings.module.css'

/**
 * Configuración → Etiquetas.
 *
 * Las etiquetas internas (Cliente, Cita agendada, Prospecto) las asigna el
 * sistema según la actividad del contacto: se muestran pero no se pueden
 * editar ni borrar. Las del usuario se crean, renombran (sin cambiar su ID,
 * así no se rompen automatizaciones ni filtros) y eliminan desde aquí.
 */
export const TagsSettings: React.FC = () => {
  const { showToast } = useNotification()
  const [tags, setTags] = useState<ContactTag[]>([])
  const [loading, setLoading] = useState(true)
  const [newTagName, setNewTagName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadTags = async () => {
    try {
      const list = await contactTagsService.getTagsWithUsage()
      setTags(list)
    } catch {
      showToast('error', 'No se pudieron cargar las etiquetas', 'Intenta recargar la página.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTags()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCreate = async () => {
    const name = newTagName.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      await contactTagsService.createTag(name)
      setNewTagName('')
      await loadTags()
      showToast('success', 'Etiqueta creada', `“${name}” ya está disponible en contactos y automatizaciones.`)
    } catch (error) {
      showToast('error', 'No se pudo crear la etiqueta', error instanceof Error ? error.message : 'Intenta de nuevo.')
    } finally {
      setCreating(false)
    }
  }

  const startRename = (tag: ContactTag) => {
    setRenamingId(tag.id)
    setRenameDraft(tag.name)
    setConfirmDeleteId(null)
  }

  const handleRename = async () => {
    if (!renamingId || savingRename) return
    const name = renameDraft.trim()
    if (!name) return
    setSavingRename(true)
    try {
      await contactTagsService.renameTag(renamingId, name)
      setRenamingId(null)
      await loadTags()
      showToast('success', 'Etiqueta renombrada', 'Los contactos y automatizaciones que la usan no se ven afectados.')
    } catch (error) {
      showToast('error', 'No se pudo renombrar', error instanceof Error ? error.message : 'Intenta de nuevo.')
    } finally {
      setSavingRename(false)
    }
  }

  const handleDelete = async (tag: ContactTag) => {
    if (deletingId) return
    setDeletingId(tag.id)
    try {
      await contactTagsService.deleteTag(tag.id)
      setConfirmDeleteId(null)
      await loadTags()
      showToast('success', 'Etiqueta eliminada', `“${tag.name}” se quitó de todos los contactos que la tenían.`)
    } catch (error) {
      showToast('error', 'No se pudo eliminar', error instanceof Error ? error.message : 'Intenta de nuevo.')
    } finally {
      setDeletingId(null)
    }
  }

  const systemTags = tags.filter((tag) => tag.isSystem)
  const customTags = tags.filter((tag) => !tag.isSystem)

  return (
    <div className={styles.container}>
      <PageHeader
        title="Etiquetas"
        subtitle="Organiza tus contactos con etiquetas. Renombrarlas no rompe filtros ni automatizaciones."
      />

      <div className={styles.createRow}>
        <input
          className={styles.createInput}
          value={newTagName}
          placeholder="Nombre de la nueva etiqueta"
          onChange={(event) => setNewTagName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              handleCreate()
            }
          }}
          disabled={creating}
        />
        <Button type="button" variant="primary" onClick={handleCreate} loading={creating} disabled={!newTagName.trim()}>
          <Plus size={16} />
          Crear etiqueta
        </Button>
      </div>

      <div>
        <h3 className={styles.sectionTitle}>Etiquetas internas</h3>
        <p className={styles.hint}>
          El sistema las asigna solo según la actividad del contacto (compras y citas). Puedes usarlas en filtros, pero no se editan ni se borran.
        </p>
        <div className={styles.list} style={{ marginTop: 8 }}>
          {systemTags.map((tag) => (
            <div key={tag.id} className={styles.row}>
              <span className={styles.tagName}>
                <Lock size={13} />
                {tag.name}
              </span>
              <span className={styles.systemBadge}>interna</span>
              <span className={styles.usage}>automática</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className={styles.sectionTitle}>Tus etiquetas</h3>
        {loading ? (
          <div className={styles.empty}>Cargando etiquetas…</div>
        ) : customTags.length === 0 ? (
          <div className={styles.empty}>
            Aún no tienes etiquetas propias. Crea la primera con el campo de arriba.
          </div>
        ) : (
          <div className={styles.list}>
            {customTags.map((tag) => {
              const isRenaming = renamingId === tag.id
              const isConfirmingDelete = confirmDeleteId === tag.id
              return (
                <div key={tag.id} className={styles.row}>
                  {isRenaming ? (
                    <>
                      <input
                        className={styles.renameInput}
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            handleRename()
                          }
                          if (event.key === 'Escape') setRenamingId(null)
                        }}
                        autoFocus
                        disabled={savingRename}
                      />
                      <div className={styles.actions} style={{ marginLeft: 'auto' }}>
                        <button
                          type="button"
                          className={styles.iconButton}
                          onClick={handleRename}
                          disabled={savingRename || !renameDraft.trim()}
                          aria-label="Guardar nombre"
                        >
                          <Check size={15} />
                        </button>
                        <button
                          type="button"
                          className={styles.iconButton}
                          onClick={() => setRenamingId(null)}
                          disabled={savingRename}
                          aria-label="Cancelar"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className={styles.tagName}>{tag.name}</span>
                      <span className={styles.usage}>
                        {tag.usageCount === 1 ? '1 contacto' : `${tag.usageCount || 0} contactos`}
                      </span>
                      <div className={styles.actions}>
                        {isConfirmingDelete && (
                          <span className={styles.confirmText}>¿Eliminar de todos los contactos?</span>
                        )}
                        {isConfirmingDelete ? (
                          <>
                            <button
                              type="button"
                              className={`${styles.iconButton} ${styles.iconButtonDanger}`}
                              onClick={() => handleDelete(tag)}
                              disabled={deletingId === tag.id}
                              aria-label="Confirmar eliminación"
                            >
                              <Check size={15} />
                            </button>
                            <button
                              type="button"
                              className={styles.iconButton}
                              onClick={() => setConfirmDeleteId(null)}
                              aria-label="Cancelar eliminación"
                            >
                              <X size={15} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={styles.iconButton}
                              onClick={() => startRename(tag)}
                              aria-label={`Renombrar ${tag.name}`}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className={`${styles.iconButton} ${styles.iconButtonDanger}`}
                              onClick={() => {
                                setConfirmDeleteId(tag.id)
                                setRenamingId(null)
                              }}
                              aria-label={`Eliminar ${tag.name}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
