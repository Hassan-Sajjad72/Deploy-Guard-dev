import { createContext, useCallback, useMemo, useState } from "react";

export const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const notify = useCallback((message, tone = "info") => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => dismiss(id), 4200);
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({ notify, dismiss }), [dismiss, notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-relevant="additions" className="toast-region">
        {toasts.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}><span>{toast.message}</span><button aria-label="Dismiss notification" onClick={() => dismiss(toast.id)} type="button">×</button></div>)}
      </div>
    </ToastContext.Provider>
  );
}
