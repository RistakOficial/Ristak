import React from 'react'

interface LayoutProps {
  sidebar: React.ReactNode
  rightSidebar?: React.ReactNode
  children: React.ReactNode
}

export const Layout: React.FC<LayoutProps> = ({ sidebar, rightSidebar, children }) => {
  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg-primary)]">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 border-r border-[rgba(148,163,184,0.12)]">
        {sidebar}
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 overflow-auto">
        {children}
      </main>

      {rightSidebar && (
        <aside className="w-[clamp(390px,32vw,520px)] flex-shrink-0 border-l border-[rgba(148,163,184,0.12)] max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-[1300] max-md:w-[min(100vw,440px)]">
          {rightSidebar}
        </aside>
      )}
    </div>
  )
}
