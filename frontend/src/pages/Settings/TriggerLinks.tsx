import React, { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Copy,
  Edit3,
  ExternalLink,
  Hash as HashIcon,
  Link2,
  Loader2,
  MousePointerClick,
  Plus,
  Power,
  Save,
  Search,
  Trash2,
  X,
  XCircle
} from 'lucide-react'
import { Button, CustomSelect, PageHeader } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  triggerLinksService,
  type TriggerLink,
  type SaveTriggerLinkInput
} from '@/services/triggerLinksService'
import styles from './CustomFields.module.css'

type LinkFilter = 'all' | 'active' | 'inactive'

type TriggerLinkDraft = {
  name: string
  destinationUrl: string
  description: string
  active: boolean
}

const emptyDraft = (): TriggerLinkDraft => ({
  name: '',
  destinationUrl: '',
  description: '',
  active: true
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

const getFilterTargetId = (filter: LinkFilter) => filter

export const TriggerLinks: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [links, setLinks] = useState<TriggerLink[]>([])
  const [activeFilter, setActiveFilter] = useState<LinkFilter>('all')
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

  const counts = useMemo(() => ({
    all: links.length,
    active: links.filter(link => link.active).length,
    inactive: links.filter(link => !link.active).length
  }), [links])

  const visibleLinks = useMemo(() => {
    const query = search.trim().toLowerCase()
    return links.filter(link => {
      if (activeFilter === 'active' && !link.active) return false
      if (activeFilter === 'inactive' && link.active) return false
      if (!query) return true
      return [
        link.name,
        link.publicId,
        link.publicUrl,
        link.destinationUrl,
        link.description
      ].some(value => String(value || '').toLowerCase().includes(query))
    })
  }, [activeFilter, links, search])

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
      destinationUrl: link.destinationUrl,
      description: link.description || '',
      active: link.active
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
      destinationUrl,
      description: draft.description.trim(),
      active: draft.active
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

  const toggleLinkActive = async (link: TriggerLink) => {
    try {
      await triggerLinksService.update(link.id, { active: !link.active })
      await loadLinks()
      showToast(
        'success',
        link.active ? 'Enlace apagado' : 'Enlace activado',
        link.active ? 'Ya no disparará automatizaciones.' : 'Ya vuelve a registrar visitas.'
      )
    } catch (error) {
      showToast('error', 'No se pudo cambiar el estado', error instanceof Error ? error.message : 'Intenta otra vez')
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

  const renderFilterButton = (filter: LinkFilter, Icon: typeof HashIcon, label: string, count: number) => (
    <div className={`${styles.folderRow} ${styles.folderSystemRow} ${activeFilter === filter ? styles.folderSystemRowActive : ''}`}>
      <button type="button" onClick={() => setActiveFilter(getFilterTargetId(filter))}>
        <Icon size={16} />
        <span>{label}</span>
        <b>{count}</b>
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
          {renderFilterButton('all', HashIcon, 'Todos los enlaces', counts.all)}
          {renderFilterButton('active', CheckCircle2, 'Activos', counts.active)}
          {renderFilterButton('inactive', XCircle, 'Apagados', counts.inactive)}
        </aside>

        <main className={styles.tablePanel}>
          <div className={styles.toolbar}>
            <label className={styles.search} data-ristak-unstyled>
              <Search size={16} />
              <input value={search} placeholder="Buscar por nombre, ID o destino" onChange={(event) => setSearch(event.target.value)} />
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
              <span>Crea un enlace nuevo o cambia de filtro.</span>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={`${styles.table} ${styles.plainTable}`}>
                <thead>
                  <tr>
                    <th>Enlace</th>
                    <th>ID</th>
                    <th>Destino</th>
                    <th>Disparos</th>
                    <th>Último disparo</th>
                    <th>Estado</th>
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
                      <td><code>{link.publicId}</code></td>
                      <td><code>{link.destinationUrl}</code></td>
                      <td>{link.clickCount}</td>
                      <td>{formatDateTime(link.lastClickedAt)}</td>
                      <td><span className={styles.typePill}>{link.active ? 'Activo' : 'Apagado'}</span></td>
                      <td>
                        <div className={styles.rowActions}>
                          <button type="button" onClick={() => copyText(link.publicUrl, 'Enlace público')} aria-label={`Copiar ${link.name}`} title="Copiar">
                            <Copy size={15} />
                          </button>
                          <button type="button" onClick={() => window.open(link.publicUrl, '_blank', 'noopener,noreferrer')} aria-label={`Abrir ${link.name}`} title="Abrir">
                            <ExternalLink size={15} />
                          </button>
                          <button type="button" onClick={() => void toggleLinkActive(link)} aria-label={link.active ? `Apagar ${link.name}` : `Activar ${link.name}`} title={link.active ? 'Apagar' : 'Activar'}>
                            <Power size={15} />
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

              <label className={styles.field}>
                <span>Descripción opcional</span>
                <textarea
                  rows={3}
                  value={draft.description}
                  placeholder="Para que tu equipo sepa dónde se usa."
                  onChange={(event) => patchDraft({ description: event.target.value })}
                />
              </label>

              <label className={styles.field}>
                <span>Estado</span>
                <CustomSelect value={draft.active ? 'active' : 'inactive'} onChange={(event) => patchDraft({ active: event.target.value === 'active' })}>
                  <option value="active">Activo</option>
                  <option value="inactive">Apagado</option>
                </CustomSelect>
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
