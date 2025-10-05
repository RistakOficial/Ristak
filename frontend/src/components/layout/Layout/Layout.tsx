import React from 'react'
import { cn } from '@/utils/cn'
import { useTheme } from '@/contexts/ThemeContext'

interface LayoutProps {
  children: React.ReactNode
  sidebar: React.ReactElement<{ onNavigate?: () => void }>
}

export const Layout: React.FC<LayoutProps> = ({ children, sidebar }) => {
  const [sidebarOpen, setSidebarOpen] = React.useState(false)
  const { theme } = useTheme()

  return (
    <div className="flex h-screen overflow-hidden relative bg-[var(--color-background-primary)]">
      <div className="absolute inset-0 app-bg pointer-events-none" aria-hidden="true" />

      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={cn(
          'w-[240px] flex-shrink-0 glass-static relative z-30 border-r',
          theme === 'light' ? 'border-[rgba(15,23,42,0.08)]' : 'border-[rgba(255,255,255,0.08)]',
          'lg:block',
          sidebarOpen ? 'fixed inset-y-0 left-0 z-50' : 'hidden lg:block'
        )}
      >
        {React.cloneElement(sidebar, {
          onNavigate: () => setSidebarOpen(false)
        })}
      </aside>

      <main className="flex-1 overflow-auto relative z-10">
        <button
          onClick={() => setSidebarOpen(true)}
          className="lg:hidden fixed top-4 left-4 z-30 p-2 rounded-lg bg-[rgba(148,163,184,0.08)] backdrop-blur-md border border-[rgba(148,163,184,0.24)]"
        >
          <svg className="w-6 h-6 text-[var(--color-text-primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        {children}
      </main>
    </div>
  )
}
