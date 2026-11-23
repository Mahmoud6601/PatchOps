import React, { createContext, useContext, useCallback, useState, useEffect } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

interface ToastContextValue {
  toast: (type: ToastType, title: string, message?: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 4500);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const styles: Record<ToastType, { bg: string; border: string; icon: string; iconColor: string }> = {
    success: { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'CheckCircle2', iconColor: 'text-emerald-600' },
    error:   { bg: 'bg-rose-50',    border: 'border-rose-200',    icon: 'XCircle',      iconColor: 'text-rose-600' },
    warning: { bg: 'bg-amber-50',   border: 'border-amber-200',   icon: 'AlertTriangle', iconColor: 'text-amber-600' },
    info:    { bg: 'bg-blue-50',    border: 'border-blue-200',    icon: 'Info',          iconColor: 'text-blue-600' },
  };
  const s = styles[toast.type];
  const Icon = toast.type === 'success' ? CheckCircle2 : toast.type === 'error' ? XCircle : toast.type === 'warning' ? AlertTriangle : Info;

  return (
    <div className={`flex items-start space-x-3 p-4 rounded-xl border shadow-lg ${s.bg} ${s.border} min-w-[300px] max-w-sm animate-in slide-in-from-right-4 fade-in duration-300`}>
      <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${s.iconColor}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-slate-900">{toast.title}</div>
        {toast.message && <div className="text-xs text-slate-600 mt-0.5">{toast.message}</div>}
      </div>
      <button onClick={() => onDismiss(toast.id)} className="shrink-0 text-slate-400 hover:text-slate-600 transition-colors">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((type: ToastType, title: string, message?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev.slice(-4), { id, type, title, message }]);
  }, []);

  const ctx: ToastContextValue = {
    toast,
    success: (title, msg) => toast('success', title, msg),
    error:   (title, msg) => toast('error',   title, msg),
    warning: (title, msg) => toast('warning', title, msg),
    info:    (title, msg) => toast('info',    title, msg),
  };

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      {/* Toast container */}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col space-y-3 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
