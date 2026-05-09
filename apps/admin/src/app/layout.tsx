// apps/admin/src/app/layout.tsx
// Admin shell with sidebar, breadcrumbs, and auth gate

'use client';

import { useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Employee } from '@snackpos/types';

const NAV_ITEMS = [
  { href: '/dashboard', icon: '📊', label: 'Dashboard' },
  { href: '/orders', icon: '📦', label: 'Orders' },
  { href: '/products', icon: '🛍', label: 'Products' },
  { href: '/inventory', icon: '📋', label: 'Inventory' },
  { href: '/customers', icon: '👥', label: 'Customers' },
  { href: '/reports', icon: '📈', label: 'Reports' },
  { href: '/employees', icon: '👤', label: 'Employees' },
  { href: '/suppliers', icon: '🏭', label: 'Suppliers' },
  { href: '/coupons', icon: '🏷', label: 'Coupons' },
  { href: '/settings', icon: '⚙️', label: 'Settings' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    if (!token && pathname !== '/login') {
      router.push('/login');
      return;
    }

    if (token) {
      fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then(({ data }) => {
          if (data) setEmployee(data);
          else {
            localStorage.removeItem('admin_token');
            router.push('/login');
          }
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [pathname]);

  const handleLogout = async () => {
    const token = localStorage.getItem('admin_token') ?? '';
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    localStorage.removeItem('admin_token');
    router.push('/login');
  };

  if (pathname === '/login') return <>{children}</>;
  if (loading) return <div className="admin-loading"><div className="spinner" /></div>;

  return (
    <div className={`admin-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      {/* Sidebar */}
      <aside className="admin-sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <span className="logo-icon">🍿</span>
            {sidebarOpen && <span className="logo-text">SnackPOS</span>}
          </div>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map(item => {
            const isActive = pathname.startsWith(item.href);
            return (
              <a
                key={item.href}
                href={item.href}
                className={`nav-item ${isActive ? 'nav-item--active' : ''}`}
                title={!sidebarOpen ? item.label : undefined}
              >
                <span className="nav-icon">{item.icon}</span>
                {sidebarOpen && <span className="nav-label">{item.label}</span>}
                {isActive && <span className="nav-indicator" />}
              </a>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          {employee && (
            <div className="sidebar-user">
              <div className="user-avatar">
                {employee.firstName[0]}{employee.lastName[0]}
              </div>
              {sidebarOpen && (
                <div className="user-info">
                  <div className="user-name">{employee.firstName} {employee.lastName}</div>
                  <div className="user-role">{employee.role}</div>
                </div>
              )}
            </div>
          )}
          <button
            className="logout-btn"
            onClick={handleLogout}
            title="Logout"
          >
            {sidebarOpen ? '← Logout' : '←'}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="admin-main">
        <div className="admin-content">
          {children}
        </div>
      </main>
    </div>
  );
}
