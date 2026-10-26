import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button, TextArea } from './ui';
import { useI18n } from '@/i18n';

function useFocusTrap(open: boolean, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(node?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
      );
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables().find((el) => !el.classList.contains('dialog-close'));
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const a = list[0];
      const b = list[list.length - 1];
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        b.focus();
      } else if (!e.shiftKey && document.activeElement === b) {
        e.preventDefault();
        a.focus();
      }
    };
    node?.addEventListener('keydown', onKey);
    return () => {
      node?.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, ref]);
}

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'narrow' | 'normal' | 'wide' | 'xwide';
  /** When true, closing asks for confirmation first. */
  dirty?: boolean;
  onSubmit?: () => void;
}

export function Dialog({ open, onClose, title, subtitle, children, footer, size = 'normal', dirty, onSubmit }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [confirmClose, setConfirmClose] = useState(false);
  const { t } = useI18n();
  useFocusTrap(open, ref);
  const requestClose = () => (dirty ? setConfirmClose(true) : onClose());
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmClose) {
        e.stopPropagation();
        requestClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!open) return null;
  const body = (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div ref={ref} className={`dialog ${size !== 'normal' ? size : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          <Button variant="ghost" size="sm" className="dialog-close" icon={<X size={18} />} aria-label={t('common.close')} onClick={requestClose} />
        </div>
        {onSubmit ? (
          <form
            className="dialog-body"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {children}
            <button type="submit" hidden aria-hidden tabIndex={-1} />
          </form>
        ) : (
          <div className="dialog-body">{children}</div>
        )}
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
      <ConfirmDialog
        open={confirmClose}
        title={t('common.unsavedTitle')}
        body={t('common.unsavedBody')}
        confirmLabel={t('common.discard')}
        cancelLabel={t('common.keepEditing')}
        danger
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
      />
    </div>
  );
  return createPortal(body, document.body);
}

export function Drawer({ open, onClose, title, subtitle, children, footer, wide, actions }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; actions?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  useFocusTrap(open, ref);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.dialog') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="overlay drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} className={`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-head">
          <div className="grow">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          {actions}
          <Button variant="ghost" size="sm" className="dialog-close" icon={<X size={18} />} aria-label={t('common.close')} onClick={onClose} />
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}

interface ConfirmProps {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /** Ask for a reason; the confirm button stays disabled until one is given. */
  reasonLabel?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  children?: ReactNode;
}

export function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel, danger, loading, reasonLabel, onConfirm, onCancel, children }: ConfirmProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="narrow"
      footer={
        <>
          <Button onClick={onCancel}>{cancelLabel ?? t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} disabled={!!reasonLabel && !reason.trim()} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {body && <p>{body}</p>}
        {children}
        {reasonLabel && <TextArea label={reasonLabel} required value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-autofocus />}
      </div>
    </Dialog>
  );
}
