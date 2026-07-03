import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Image as ImageIcon, RefreshCw } from 'lucide-react'
import { SearchField } from '../common/SearchField/SearchField'
import { useAnchoredPortal } from '@/hooks/useAnchoredPortal'
import { whatsappApiService, type MetaSocialPost } from '../../services/whatsappApiService'
import styles from './MetaPostSelector.module.css'

interface MetaPostSelectorProps {
  platform: 'facebook' | 'instagram'
  value: string
  valueLabel?: string
  onChange: (value: string, label: string) => void
  disabled?: boolean
  allLabel?: string
  'aria-label'?: string
}

const PAGE_SIZE = 20

// Selector de publicaciones de FB/IG: dropdown con buscador (por nombre o ID),
// miniatura del post y paginación. La opción "Todas las publicaciones" (value '')
// significa sin filtro. Reutilizado por disparadores, condiciones y acciones.
export function MetaPostSelector({
  platform,
  value,
  valueLabel,
  onChange,
  disabled,
  allLabel = 'Todas las publicaciones',
  'aria-label': ariaLabel
}: MetaPostSelectorProps) {
  const [open, setOpen] = useState(false)
  const [posts, setPosts] = useState<MetaSocialPost[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Portal: el panel se monta en <body> y siempre queda por delante (sin recortes).
  const { style: portalStyle, placement } = useAnchoredPortal(rootRef, open, { minWidth: 320, maxHeight: 360 })

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 300)
    return () => window.clearTimeout(t)
  }, [search])

  const load = useCallback(async (nextOffset: number, opts: { append?: boolean; refresh?: boolean } = {}) => {
    setLoading(true)
    setError('')
    try {
      const res = await whatsappApiService.listMetaSocialPosts({
        platform,
        search: debounced,
        limit: PAGE_SIZE,
        offset: nextOffset,
        refresh: opts.refresh
      })
      const list = Array.isArray(res?.posts) ? res.posts : []
      setPosts((cur) => (opts.append ? [...cur, ...list] : list))
      setHasMore(Boolean(res?.hasMore))
      setOffset(nextOffset)
      if (res && res.success === false && res.error) setError(res.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las publicaciones')
      if (!opts.append) setPosts([])
    } finally {
      setLoading(false)
    }
  }, [platform, debounced])

  useEffect(() => {
    if (!open) return
    load(0)
  }, [open, debounced, load])

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const selectedLabel = useMemo(() => {
    if (!value) return allLabel
    const inList = posts.find((p) => p.id === value)
    return (inList?.message || valueLabel || value).trim() || value
  }, [value, valueLabel, posts, allLabel])

  const pick = (postValue: string, label: string) => {
    onChange(postValue, label)
    setOpen(false)
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={value ? styles.triggerLabel : styles.triggerAll}>{selectedLabel}</span>
        <ChevronDown size={16} className={styles.chevron} aria-hidden="true" />
      </button>

      {open && createPortal(
        <div className={styles.panel} role="listbox" ref={panelRef} style={portalStyle} data-placement={placement}>
          <div className={styles.searchRow}>
            <SearchField
              value={search}
              onChange={(next) => setSearch(next)}
              onClear={() => setSearch('')}
              placeholder="Buscar por nombre o ID…"
              className={styles.searchField}
              autoFocus
            />
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={() => load(0, { refresh: true })}
              title="Actualizar desde Meta"
              aria-label="Actualizar desde Meta"
            >
              <RefreshCw size={14} className={loading ? styles.spin : ''} aria-hidden="true" />
            </button>
          </div>

          <button
            type="button"
            className={`${styles.option} ${styles.optionAll} ${!value ? styles.optionActive : ''}`}
            onClick={() => pick('', allLabel)}
          >
            <span className={styles.optionAllText}>{allLabel}</span>
            {!value && <Check size={15} aria-hidden="true" />}
          </button>

          <div className={styles.list}>
            {posts.map((post) => (
              <button
                key={post.id}
                type="button"
                className={`${styles.option} ${value === post.id ? styles.optionActive : ''}`}
                onClick={() => pick(post.id, post.message || post.id)}
              >
                <span className={styles.thumb}>
                  {post.imageUrl ? <img src={post.imageUrl} alt="" loading="lazy" /> : <ImageIcon size={16} aria-hidden="true" />}
                </span>
                <span className={styles.optionBody}>
                  <span className={styles.optionText}>{post.message || '(publicación sin texto)'}</span>
                  <span className={styles.optionMeta}>{post.postedAt ? new Date(post.postedAt).toLocaleDateString() : post.id}</span>
                </span>
                {value === post.id && <Check size={15} className={styles.optionCheck} aria-hidden="true" />}
              </button>
            ))}

            {loading && <div className={styles.hint}>Cargando publicaciones…</div>}
            {!loading && !posts.length && !error && (
              <div className={styles.hint}>No hay publicaciones{debounced ? ' para esa búsqueda' : ''}.</div>
            )}
            {error && <div className={styles.errorHint}>{error}</div>}
            {hasMore && !loading && (
              <button type="button" className={styles.loadMore} onClick={() => load(offset + PAGE_SIZE, { append: true })}>
                Cargar más
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default MetaPostSelector
