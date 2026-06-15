import React, { useEffect, useMemo, useState } from 'react'
import {
  Copy,
  Edit3,
  ExternalLink,
  Hash as HashIcon,
  Link2,
  Loader2,
  MousePointerClick,
  Plus,
  Save,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { Button, PageHeader } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  triggerLinksService,
  type TriggerLink,
  type SaveTriggerLinkInput
} from '@/services/triggerLinksService'
import styles from './CustomFields.module.css'

type TriggerLinkDraft = {
  name: string
  destinationUrl: string
}

const emptyDraft = (): TriggerLinkDraft => ({
  name: '',
  destinationUrl: ''
})

const formatDateTime = (value?: string | null) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

const triggerLinkParameter = (link: Pick<TriggerLink, 'publicId'>) => `{{trigger_link.${link.publicId}}}`

export const TriggerLinks: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [links, setLinks] = useState<TriggerLink[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingLink, setEditingLink] = useState<TriggerLink | null>(null)
  const [draft, setDraft] = useState<TriggerLinkDraft>(emptyDraft())

  const loadLinks = async () => {
    setLoading(true)
    try {
      const nextLinks = await triggerLinksService.list()
      setLinks(nextLinks || [])
    } catch (error) {
      showToast('error', 'No se pudieron cargar los enlaces', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadLinks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visibleLinks = useMemo(() => {
    const query = search.trim().toLowerCase()
    return links.filter(link => {
      if (!query) return true
      return [
        link.name,
        link.publicId,
        triggerLinkParameter(link),
        link.publicUrl,
        link.destinationUrl
      ].some(value => String(value || '').toLowerCase().includes(query))
    })
  }, [links, search])

  const patchDraft = (patch: Partial<TriggerLinkDraft>) => {
    setDraft(current => ({ ...current, ...patch }))
  }

  const openCreateEditor = () => {
    setEditingLink(null)
    setDraft(emptyDraft())
    setEditorOpen(true)
  }

  const openEditEditor = (link: TriggerLink) => {
    setEditingLink(link)
    setDraft({
      name: link.name,
      destinationUrl: link.destinationUrl
    })
    setEditorOpen(true)
  }

  const closeEditor = () => {
    if (saving) return
    setEditorOpen(false)
    setEditingLink(null)
    setDraft(emptyDraft())
  }

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast('success', 'Copiado', `${label} copiado.`)
    } catch {
      showToast('error', 'No se pudo copiar', 'Copia el enlace manualmente.')
    }
  }

  const buildPayload = (): SaveTriggerLinkInput | null => {
    const name = draft.name.trim()
    const destinationUrl = draft.destinationUrl.trim()
    if (!name) {
      showToast('warning', 'Falta nombre', 'Ponle un nombre al enlace.')
      return null
    }
    if (!destinationUrl) {
      showToast('warning', 'Falta destino', 'Pega la URL o ruta a donde debe mandar.')
      return null
    }
    return {
      name,
      destinationUrl
    }
  }

  const handleSaveLink = async () => {
    const payload = buildPayload()
    if (!payload) return

    setSaving(true)
    try {
      if (editingLink) {
        await triggerLinksService.update(editingLink.id, payload)
        showToast('success', 'Enlace actualizado', 'Los disparos nuevos ya usan esta configuración.')
      } else {
        await triggerLinksService.create(payload)
        showToast('success', 'Enlace creado', 'Ya puedes copiarlo y usarlo en automatizaciones.')
      }
      closeEditor()
      await loadLinks()
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteLink = (link: TriggerLink) => {
    showConfirm(
      'Eliminar enlace',
      `El enlace "${link.name}" dejará de funcionar. Los disparos históricos se conservan para consulta interna.`,
      () => {
        const archive = async () => {
          try {
            await triggerLinksService.delete(link.id)
            await loadLinks()
            showToast('success', 'Enlace eliminado', 'La URL pública ya no está activa.')
          } catch (error) {
            showToast('error', 'No se pudo eliminar', error instanceof Error ? error.message : 'Intenta otra vez')
          }
        }
        void archive()
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const renderFilterButton = () => (
    <div className={`${styles.folderRow} ${styles.folderSystemRow} ${styles.folderSystemRowActive}`}>
      <button type="button" aria-current="true">
        <HashIcon size={16} />
        <span>Todos los enlaces</span>
        <b>{links.length}</b>
      </button>
      <span className={styles.folderActionSpacer} aria-hidden="true" />
    </div>
  )

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Sistema"
        title="Enlaces de disparo"
        subtitle="Crea URLs públicas que registran cada visita y después mandan a la persona al destino que configures."
        actions={
          <Button onClick={openCreateEditor} leftIcon={<Plus size={16} />}>
            Nuevo enlace
          </Button>
        }
      />

      <div className={styles.layout}>
        <aside className={styles.folders} aria-label="Filtros de enlaces de disparo">
          <div className={styles.folderHeader}>
            <strong>Filtros</strong>
            <span>{links.length} enlaces</span>
          </div>
          {renderFilterButton()}
        </aside>

        <main className={styles.tablePanel}>
          <div className={styles.toolbar}>
            <label className={styles.search} data-ristak-unstyled>
              <Search size={16} />
              <input value={search} placeholder="Buscar por nombre, parámetro o destino" onChange={(event) => setSearch(event.target.value)} />
            </label>
            <span>{visibleLinks.length} enlaces</span>
          </div>

          {loading ? (
            <div className={styles.loadingState}>
              <Loader2 className={styles.spin} size={22} />
              <span>Cargando enlaces...</span>
            </div>
          ) : visibleLinks.length === 0 ? (
            <div className={styles.emptyState}>
              <Link2 size={26} />
              <strong>No hay enlaces en esta vista</strong>
              <span>Crea un enlace nuevo o ajusta la búsqueda.</span>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={`${styles.table} ${styles.plainTable}`}>
                <thead>
                  <tr>
                    <th>Enlace</th>
                    <th>Parámetro</th>
                    <th>Destino</th>
                    <th>Disparos</th>
                    <th>Último disparo</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {visibleLinks.map(link => (
                    <tr key={link.id}>
                      <td>
                        <strong>{link.name}</strong>
                        <span>{link.publicUrl}</span>
                      </td>
                      <td><code>{triggerLinkParameter(link)}</code></td>
                      <td><code>{link.destinationUrl}</code></td>
                      <td>{link.clickCount}</td>
                      <td>{formatDateTime(link.lastClickedAt)}</td>
                      <td>
                        <div className={styles.rowActions}>
                          <button type="button" onClick={() => copyText(triggerLinkParameter(link), 'Parámetro')} aria-label={`Copiar ${link.name}`} title="Copiar parámetro">
                            <Copy size={15} />
                          </button>
                          <button type="button" onClick={() => window.open(link.publicUrl, '_blank', 'noopener,noreferrer')} aria-label={`Abrir ${link.name}`} title="Abrir">
                            <ExternalLink size={15} />
                          </button>
                          <button type="button" onClick={() => openEditEditor(link)} aria-label={`Editar ${link.name}`} title="Editar">
                            <Edit3 size={15} />
                          </button>
                          <button type="button" onClick={() => handleDeleteLink(link)} aria-label={`Eliminar ${link.name}`} title="Eliminar">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>

      {editorOpen && (
        <div className={styles.editorOverlay} role="dialog" aria-modal="true" aria-labelledby="trigger-link-editor-title">
          <section className={styles.editorPanel}>
            <div className={styles.editorHeader}>
              <div>
                <p className={styles.eyebrow}>{editingLink ? 'Editar enlace' : 'Nuevo enlace'}</p>
                <h3 id="trigger-link-editor-title">{editingLink ? editingLink.name : 'Crear enlace de disparo'}</h3>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeEditor} aria-label="Cerrar editor">
                <X size={18} />
              </button>
            </div>

            <div className={styles.editorBody}>
              <label className={styles.field}>
                <span>Nombre visible</span>
                <input value={draft.name} placeholder="Ej. PDF de bienvenida" onChange={(event) => patchDraft({ name: event.target.value })} />
              </label>

              <label className={styles.field}>
                <span>Destino final</span>
                <input value={draft.destinationUrl} placeholder="https://tusitio.com/promo.pdf" onChange={(event) => patchDraft({ destinationUrl: event.target.value })} />
                <small>Puede ser una URL externa, un PDF, una página o una ruta interna que empiece con /.</small>
              </label>

              {editingLink && (
                <div className={styles.typeHint}>
                  <MousePointerClick size={15} />
                  <span>Este enlace lleva {editingLink.clickCount} disparo{editingLink.clickCount === 1 ? '' : 's'} registrado{editingLink.clickCount === 1 ? '' : 's'}.</span>
                </div>
              )}
            </div>

            <div className={styles.editorActions}>
              <Button type="button" variant="ghost" onClick={closeEditor} disabled={saving}>
                Cancelar
              </Button>
              <Button type="button" onClick={() => void handleSaveLink()} loading={saving} leftIcon={<Save size={16} />}>
                {editingLink ? 'Guardar enlace' : 'Crear enlace'}
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
