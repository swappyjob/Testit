import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Modal } from './components.jsx';

// A reliable, in-app replacement for window.confirm / window.alert. Native
// dialogs can be silently suppressed by the browser (embedded webviews, or once
// a user ticks "don't let this page create more dialogs"), which makes the
// guarded action appear dead. These render a real modal instead.
const ConfirmCtx = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const resolver = useRef(null);

  const ask = useCallback((opts, isAlert) => {
    const o = typeof opts === 'string' ? { body: opts } : (opts || {});
    return new Promise((resolve) => {
      resolver.current = resolve;
      setState({
        title: o.title || (isAlert ? 'Notice' : 'Are you sure?'),
        body: o.body || '',
        confirmLabel: o.confirmLabel || (isAlert ? 'OK' : 'Confirm'),
        cancelLabel: o.cancelLabel || 'Cancel',
        danger: !!o.danger,
        alert: !!isAlert,
      });
    });
  }, []);

  const confirm = useCallback((opts) => ask(opts, false), [ask]);
  const alert = useCallback((opts) => ask(opts, true), [ask]);

  const close = (val) => {
    const r = resolver.current;
    resolver.current = null;
    setState(null);
    if (r) r(val);
  };

  return (
    <ConfirmCtx.Provider value={{ confirm, alert }}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => close(false)}>
          {state.body && <p style={{ marginTop: 0, whiteSpace: 'pre-line' }}>{state.body}</p>}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
            {!state.alert && <button className="btn ghost" type="button" onClick={() => close(false)}>{state.cancelLabel}</button>}
            <button className={'btn' + (state.danger ? ' danger' : '')} type="button" onClick={() => close(true)} autoFocus>{state.confirmLabel}</button>
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

// Returns confirm(opts) -> Promise<boolean>. opts is a string or
// { title, body, confirmLabel, cancelLabel, danger }.
export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  return ctx ? ctx.confirm : async (o) => window.confirm(typeof o === 'string' ? o : (o && o.body) || 'Are you sure?');
}
// Returns alert(opts) -> Promise<void>.
export function useAlert() {
  const ctx = useContext(ConfirmCtx);
  return ctx ? ctx.alert : async (o) => window.alert(typeof o === 'string' ? o : (o && o.body) || '');
}
