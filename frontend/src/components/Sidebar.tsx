import React, { useState } from 'react';
import {
  LayoutDashboard,
  Server,
  History,
  Calendar,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  Zap,
  Users,
  Activity,
} from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { User } from '../types';

interface SidebarProps {
  currentUser: User;
}

const SIDEBAR_COLLAPSED_KEY = 'patching_sidebar_collapsed';

export const Sidebar: React.FC<SidebarProps> = ({ currentUser }) => {
  const location = useLocation();
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    }
    return false;
  });

  const toggleCollapsed = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      }
      return next;
    });
  };

  type NavItem = {
    path: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: string;
    matchPrefix?: string;
  };

  const sections: { title: string; items: NavItem[] }[] = [
    {
      title: 'Overview',
      items: [
        { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      ],
    },
    {
      title: 'Endpoints',
      items: [
        { path: '/servers', label: 'Endpoint Inventory', icon: Server, badge: 'Core' },
      ],
    },
    {
      title: 'Operations',
      items: [
        { path: '/runs', matchPrefix: '/runs', label: 'Execution History', icon: History },
        { path: '/schedules', label: 'Automation Policies', icon: Calendar },
      ],
    },
    ...(currentUser.role === 'administrator'
      ? [
          {
            title: 'Governance',
            items: [
              { path: '/audit', label: 'Audit Trail', icon: ShieldAlert },
              { path: '/users', label: 'Team Members', icon: Users },
            ],
          },
        ]
      : []),
  ];

  return (
    <aside
      className={`border-r border-slate-200 bg-white flex flex-col justify-between shrink-0 min-h-[calc(100vh-4rem)] transition-all duration-300 ease-in-out ${
        isCollapsed ? 'w-[60px] p-2' : 'w-60 p-3'
      }`}
    >
      <div className="space-y-1">
        <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'justify-end'} pb-2 pt-1`}>
          <button
            onClick={toggleCollapsed}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <div className="space-y-4">
          {sections.map((section, sIdx) => (
            <div key={sIdx} className="space-y-0.5">
              {!isCollapsed && (
                <div className="px-3 py-1 text-[10px] font-bold tracking-widest text-slate-400 uppercase font-mono">
                  {section.title}
                </div>
              )}
              {isCollapsed && sIdx > 0 && (
                <div className="border-t border-slate-100 my-2" />
              )}
              {section.items.map((item) => {
                const Icon = item.icon;
                const isActive = item.matchPrefix
                  ? location.pathname.startsWith(item.matchPrefix)
                  : location.pathname === item.path;
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    title={isCollapsed ? item.label : undefined}
                    className={`w-full flex items-center ${
                      isCollapsed ? 'justify-center px-2 py-2.5' : 'space-x-3 px-3 py-2'
                    } rounded-lg text-sm font-medium transition-all relative ${
                      isActive
                        ? 'bg-blue-50 text-blue-700 font-semibold'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                    }`}
                  >
                    {isActive && !isCollapsed && (
                      <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-blue-600" />
                    )}
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-blue-600' : 'text-slate-400'}`} />
                    {!isCollapsed && (
                      <span className="flex-1 text-left truncate text-[13px]">{item.label}</span>
                    )}
                    {!isCollapsed && item.badge && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-bold uppercase tracking-wide">
                        {item.badge}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {!isCollapsed ? (
        <div className="mt-4 p-3 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 text-xs">
          <div className="flex items-center space-x-1.5 text-slate-700 font-semibold mb-1">
            <Activity className="w-3.5 h-3.5 text-blue-600" />
            <span>Automation Engine</span>
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            AWX-powered patch orchestration with scoped RBAC &amp; live SSE.
          </p>
        </div>
      ) : (
        <div className="flex justify-center p-2 mt-4" title="Automation Engine Online">
          <Zap className="w-4 h-4 text-blue-600" />
        </div>
      )}
    </aside>
  );
};
