import React from 'react'

interface LayoutProps {
  sidebar: React.ReactNode
  sidebarCollapsed?: boolean
  rightSidebar?: React.ReactNode
  children: React.ReactNode
}

export const Layout: React.FC<LayoutProps> = ({ sidebar, sidebarCollapsed = false, rightSidebar, children }) => {
  return (
    <div data-ristak-layout className="flex h-screen overflow-hidden bg-[var(--color-bg-primary)]">
      {/* Sidebar */}
      <aside
        data-ristak-layout-sidebar
        data-collapsed={sidebarCollapsed ? 'true' : undefined}
        className={`${sidebarCollapsed ? 'w-[var(--app-sidebar-collapsed-width,5rem)]' : 'w-[var(--app-sidebar-width,14rem)]'} flex-shrink-0 border-r border-[var(--border)] transition-[width] duration-200 ease-out`}
      >
        {sidebar}
      </aside>

      {/* Main Content */}
      <main data-ristak-layout-main className="flex-1 min-w-0 overflow-auto">
        {children}
      </main>

      {rightSidebar && (
        <aside data-ristak-layout-right-sidebar className="w-[clamp(390px,32vw,520px)] flex-shrink-0 border-l border-[rgba(148,163,184,0.12)] max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-[1300] max-md:w-[min(100vw,440px)]">
          {rightSidebar}
        </aside>
      )}
    </div>
  )
}
