'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

const AlertToastContext = createContext(null);

// confirmDialog(message) replaces window.confirm: it resolves true/false from an
// in-app dialog. It works from any handler without a hook; before the provider
// has mounted it falls back to the browser's own prompt.
let openConfirm = null;

export function confirmDialog(message, options = {}) {
  if (!openConfirm) return Promise.resolve(typeof window !== 'undefined' ? window.confirm(message) : false);
  return openConfirm({ message: normalizeMessage(message), ...options });
}

const DANGER_WORDS = /delete|remove|void|cancel|permanent|cannot be undone|clear/i;

const DEFAULT_DURATION = 4500;
const MAX_TOASTS = 4;

const VARIANT_STYLES = {
  info: {
    container: 'border-info/30 bg-info-light/80 text-info',
    icon: Info,
  },
  success: {
    container: 'border-success/30 bg-success-light/80 text-success',
    icon: CheckCircle2,
  },
  warning: {
    container: 'border-warning/30 bg-warning-light/80 text-warning',
    icon: AlertTriangle,
  },
  danger: {
    container: 'border-danger/30 bg-danger-light/80 text-danger',
    icon: AlertCircle,
  },
};

function normalizeMessage(message) {
  if (typeof message === 'string') return message.trim();
  if (message instanceof Error) return (message.message || '').trim();
  if (message === null || message === undefined) return '';
  try {
    return JSON.stringify(message);
  } catch {
    return String(message).trim();
  }
}

function inferVariantFromMessage(rawMessage) {
  const message = (rawMessage || '').toLowerCase();

  if (message.includes('error') || message.includes('failed') || message.includes('unable') || message.includes('cannot')) {
    return 'danger';
  }

  if (message.includes('success') || message.includes('saved') || message.includes('sent') || message.includes('created')) {
    return 'success';
  }

  if (message.includes('warning') || message.includes('please') || message.includes('maximum') || message.includes('required')) {
    return 'warning';
  }

  return 'info';
}

export default function AlertToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());
  const [confirmRequest, setConfirmRequest] = useState(null);
  const confirmButtonRef = useRef(null);

  const answerConfirm = useCallback((answer) => {
    setConfirmRequest((current) => {
      current?.resolve(answer);
      return null;
    });
  }, []);

  useEffect(() => {
    openConfirm = (request) => new Promise((resolve) => {
      // A second prompt while one is open cancels the first.
      setConfirmRequest((current) => {
        current?.resolve(false);
        return { ...request, resolve };
      });
    });
    return () => {
      openConfirm = null;
    };
  }, []);

  useEffect(() => {
    if (!confirmRequest) return undefined;
    confirmButtonRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') answerConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmRequest, answerConfirm]);

  const dismissToast = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }

    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((message, options = {}) => {
    const text = normalizeMessage(message);
    if (!text) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const variant = options.variant || inferVariantFromMessage(text);
    const duration = typeof options.duration === 'number' ? options.duration : DEFAULT_DURATION;

    setToasts((previous) => {
      const next = [...previous, { id, text, variant }];
      return next.slice(-MAX_TOASTS);
    });

    if (duration > 0) {
      const timeout = window.setTimeout(() => dismissToast(id), duration);
      timersRef.current.set(id, timeout);
    }
  }, [dismissToast]);

  useEffect(() => {
    const timers = timersRef.current;

    return () => {
      timers.forEach((timeout) => window.clearTimeout(timeout));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const originalAlert = window.alert;

    window.alert = (message) => {
      notify(message, { variant: inferVariantFromMessage(normalizeMessage(message)) });
    };

    return () => {
      window.alert = originalAlert;
    };
  }, [notify]);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <AlertToastContext.Provider value={value}>
      {children}

      <div className="pointer-events-none fixed inset-x-0 bottom-3 z-[120] px-3 md:bottom-5 md:px-6">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-2 md:mr-0 md:max-w-md">
          {toasts.map((toast) => {
            const style = VARIANT_STYLES[toast.variant] || VARIANT_STYLES.info;
            const Icon = style.icon;

            return (
              <div
                key={toast.id}
                className={`pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg backdrop-blur-sm animate-[slide-up_0.24s_ease-out] ${style.container}`}
                role="status"
                aria-live="polite"
              >
                <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />

                <p className="flex-1 text-xs md:text-sm font-medium whitespace-pre-line leading-relaxed text-foreground">
                  {toast.text}
                </p>

                <button
                  type="button"
                  onClick={() => dismissToast(toast.id)}
                  className="touch-target -mr-2 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-xl text-muted hover:bg-black/5 hover:text-foreground"
                  aria-label="Dismiss notification"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {confirmRequest && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) answerConfirm(false); }}>
          <div role="alertdialog" aria-modal="true" aria-label={confirmRequest.title || 'Please confirm'} className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-foreground">{confirmRequest.title || 'Please confirm'}</h3>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">{confirmRequest.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => answerConfirm(false)} className="rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-muted hover:text-foreground">
                {confirmRequest.cancelLabel || 'Cancel'}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                onClick={() => answerConfirm(true)}
                className={`rounded-xl px-4 py-2 text-sm font-semibold text-white ${(confirmRequest.danger ?? DANGER_WORDS.test(confirmRequest.message)) ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent-hover'}`}
              >
                {confirmRequest.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AlertToastContext.Provider>
  );
}

export function useAlertToast() {
  const context = useContext(AlertToastContext);

  if (!context) {
    return {
      notify: (message) => {
        window.alert(message);
      },
    };
  }

  return context;
}
