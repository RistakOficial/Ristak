import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Calendar,
  CreditCard,
  Layers,
  Megaphone,
  MousePointerClick,
  Search,
  User,
  X
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { globalSearchService, type GlobalSearchCategory, type GlobalSearchItem, type GlobalSearchItemType } from '@/services/globalSearchService'
import { buildSearchIndex, searchIndexIncludes } from '@/utils/searchText'
import styles from './GlobalSearch.module.css'

interface GlobalSearchProps {
  className?: string
}

const ICONS: Record<GlobalSearchItemType, React.ComponentType<{ size?: number; className?: string }>> = {
  contact: User,
  appointment: Calendar,
  payment: CreditCard,
  campaign: Megaphone,
  adset: Layers,
  ad: MousePointerClick
}

const GLOBAL_SEARCH_DELAY_MS = 60
const GLOBAL_SEARCH_CACHE_LIMIT = 30

const buildSearchParams = (item: GlobalSearchItem) => {
  const params = new URLSearchParams()

  if (item.type === 'contact') {
    params.set('open', 'contact')
    params.set('id', item.id)
    return { pathname: '/contacts', search: `?${params.toString()}` }
  }

  if (item.type === 'appointment') {
    params.set('open', 'appointment')
    params.set('id', item.id)
    return { pathname: '/appointments', search: `?${params.toString()}` }
  }

  if (item.type === 'payment') {
    params.set('open', 'payment')
    params.set('id', item.id)
    return { pathname: '/transactions', search: `?${params.toString()}` }
  }

  params.set('open', 'campaign')
  params.set('level', item.type)
  params.set('id', item.id)

  const campaignId = item.metadata?.campaignId
  const adsetId = item.metadata?.adsetId
  const adId = item.metadata?.adId
  const lastDate = item.metadata?.lastDate

  if (campaignId) params.set('campaignId', String(campaignId))
  if (adsetId) params.set('adsetId', String(adsetId))
  if (adId) params.set('adId', String(adId))
  if (lastDate) params.set('date', String(lastDate).slice(0, 10))

  return { pathname: '/campaigns', search: `?${params.toString()}` }
}

const filterCategoriesByQuery = (
  categories: GlobalSearchCategory[],
  query: string
): GlobalSearchCategory[] => {
  return categories
    .map(category => ({
      ...category,
      items: category.items.filter(item =>
        searchIndexIncludes(
          buildSearchIndex([
            item.title,
            item.subtitle,
            item.meta,
            item.id,
            item.type,
            ...Object.values(item.metadata ?? {})
          ]),
          query
        )
      )
    }))
    .filter(category => category.items.length > 0)
}

export const GlobalSearch: React.FC<GlobalSearchProps> = ({ className }) => {
  const navigate = useNavigate()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cacheRef = useRef(new Map<string, GlobalSearchCategory[]>())
  const latestCategoriesRef = useRef<GlobalSearchCategory[]>([])
  const [query, setQuery] = useState('')
  const [categories, setCategories] = useState<GlobalSearchCategory[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  const trimmedQuery = query.trim()

  const flatResults = useMemo(() => {
    return categories.flatMap((category) =>
      category.items.map((item) => ({
        ...item,
        categoryLabel: category.label
      }))
    )
  }, [categories])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!trimmedQuery) {
      setCategories([])
      setLoading(false)
      setError(null)
      setActiveIndex(0)
      return
    }

    const cachedCategories = cacheRef.current.get(trimmedQuery)
    const optimisticCategories = cachedCategories
      ?? filterCategoriesByQuery(latestCategoriesRef.current, trimmedQuery)

    setCategories(optimisticCategories)
    setIsOpen(true)
    setActiveIndex(0)
    setLoading(true)
    setError(null)

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      globalSearchService.search(trimmedQuery, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return

          cacheRef.current.set(trimmedQuery, response.categories)
          if (cacheRef.current.size > GLOBAL_SEARCH_CACHE_LIMIT) {
            const oldestKey = cacheRef.current.keys().next().value
            if (oldestKey) cacheRef.current.delete(oldestKey)
          }

          latestCategoriesRef.current = response.categories
          setCategories(response.categories)
          setActiveIndex(0)
          setIsOpen(true)
        })
        .catch((searchError) => {
          if (searchError instanceof DOMException && searchError.name === 'AbortError') {
            return
          }
          setCategories([])
          setError('No se pudo buscar en este momento')
          setIsOpen(true)
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false)
          }
        })
    }, 180)

    return () => {
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [trimmedQuery])

  const clearSearch = () => {
    setQuery('')
    setCategories([])
    setError(null)
    setIsOpen(false)
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  const selectItem = (item: GlobalSearchItem) => {
    navigate(buildSearchParams(item))
    setQuery('')
    setCategories([])
    setIsOpen(false)
    setActiveIndex(0)
  }

  const selectActiveItem = () => {
    const selected = flatResults[activeIndex] ?? flatResults[0]
    if (selected) {
      selectItem(selected)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setIsOpen(false)
      return
    }

    if (!isOpen && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
      setIsOpen(true)
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, Math.max(flatResults.length - 1, 0)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      selectActiveItem()
    }
  }

  const showDropdown = isOpen && Boolean(trimmedQuery)
  let globalIndex = 0

  return (
    <div ref={rootRef} className={cn(styles.root, className)}>
      <div className={styles.inputWrap}>
        <Search size={17} className={styles.inputIcon} />
        <input
          ref={inputRef}
          type="text"
          placeholder="Buscar"
          className={styles.input}
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setIsOpen(Boolean(event.target.value.trim()))
          }}
          onFocus={() => {
            if (trimmedQuery) setIsOpen(true)
          }}
          onKeyDown={handleKeyDown}
          aria-expanded={showDropdown}
          aria-controls="global-search-results"
        />
        {query && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={clearSearch}
            aria-label="Limpiar búsqueda"
          >
            <X size={15} />
          </button>
        )}
        <button
          type="button"
          className={styles.searchButton}
          onClick={selectActiveItem}
          title="Abrir primer resultado"
          aria-label="Abrir primer resultado"
          disabled={flatResults.length === 0}
        >
          <Search size={16} />
        </button>
      </div>

      {showDropdown && (
        <div id="global-search-results" className={styles.dropdown} role="listbox" data-ristak-dropdown-panel>
          {loading && categories.length === 0 && (
            <div className={styles.stateRow}>Buscando...</div>
          )}

          {error && categories.length === 0 && (
            <div className={styles.stateRow}>{error}</div>
          )}

          {!loading && !error && categories.length === 0 && (
            <div className={styles.stateRow}>Sin resultados</div>
          )}

          {categories.map((category) => (
            <section key={category.id} className={styles.category}>
              <div className={styles.categoryHeader}>{category.label}</div>
              <div className={styles.resultList}>
                {category.items.map((item) => {
                  const Icon = ICONS[item.type]
                  const itemIndex = globalIndex++
                  const isActive = itemIndex === activeIndex

                  return (
                    <button
                      key={`${item.type}-${item.id}`}
                      type="button"
                      className={cn(styles.resultItem, isActive && styles.resultItemActive)}
                      data-ristak-dropdown-item
                      data-active={isActive ? 'true' : undefined}
                      onMouseEnter={() => setActiveIndex(itemIndex)}
                      onClick={() => selectItem(item)}
                      role="option"
                      aria-selected={isActive}
                    >
                      <span className={styles.resultIcon}>
                        <Icon size={16} />
                      </span>
                      <span className={styles.resultBody}>
                        <span className={styles.resultTitle}>{item.title}</span>
                        {item.subtitle && <span className={styles.resultSubtitle}>{item.subtitle}</span>}
                      </span>
                      {item.meta && <span className={styles.resultMeta}>{item.meta}</span>}
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
