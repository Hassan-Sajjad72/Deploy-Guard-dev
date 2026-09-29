import { productText } from "../utils/productTerms.js";
import { reportActionOutcome } from "../utils/actionFeedback.js";
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";

export const ToastContext = createContext(null);

const LIFETIME_MS = 4200;
const EXIT_MS = 180;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  // Per-toast dismiss timers; hovering a toast pauses its timer.
  const timers = useRef(new Map());

  const remove = useCallback((id) => {
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const dismiss = useCallback((id) => {
    const timer = timers.current.get(id);
    if (timer?.handle) window.clearTimeout(timer.handle);
    setToasts((current) => current.map((toast) => toast.id === id ? { ...toast, leaving: true } : toast));
    window.setTimeout(() => remove(id), EXIT_MS);
  }, [remove]);

  const schedule = useCallback((id, delay) => {
    const handle = window.setTimeout(() => dismiss(id), delay);
    timers.current.set(id, { handle, due: Date.now() + delay, remaining: delay });
  }, [dismiss]);

  const pause = useCallback((id) => {
    const timer = timers.current.get(id);
    if (!timer?.handle) return;
    window.clearTimeout(timer.handle);
    timers.current.set(id, { handle: null, due: 0, remaining: Math.max(600, timer.due - Date.now()) });
  }, []);

  const resume = useCallback((id) => {
    const timer = timers.current.get(id);
    if (timer && !timer.handle) schedule(id, timer.remaining);
  }, [schedule]);

  const notify = useCallback((message, tone = "info") => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-3), { id, message, tone, leaving: false }]);
    schedule(id, LIFETIME_MS);
    reportActionOutcome(tone);
    return id;
  }, [schedule]);

  useEffect(() => () => { timers.current.forEach((timer) => timer.handle && window.clearTimeout(timer.handle)); }, []);

  const value = useMemo(() => ({ notify, dismiss }), [dismiss, notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-relevant="additions" className="toast-region">
        {toasts.map((toast) => <div className={`toast toast-${toast.tone}${toast.leaving ? " is-leaving" : ""}`} key={toast.id} onBlur={() => resume(toast.id)} onFocus={() => pause(toast.id)} onMouseEnter={() => pause(toast.id)} onMouseLeave={() => resume(toast.id)}><span>{productText(toast.message)}</span><button aria-label="Dismiss notification" onClick={() => dismiss(toast.id)} type="button">×</button></div>)}
      </div>
    </ToastContext.Provider>
  );
}
