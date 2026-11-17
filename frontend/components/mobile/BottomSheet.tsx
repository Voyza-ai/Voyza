'use client';

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls, type PanInfo } from 'framer-motion';
import { X } from 'lucide-react';

type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible name and visible title. */
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** 'dark' is the #0f0f1a AI surface. */
  tone?: 'light' | 'dark';
  /** Fill most of the screen (chat, guides) rather than hug the content. */
  tall?: boolean;
  /** Pinned under the scrolling body (actions, an input). */
  footer?: ReactNode;
  testId?: string;
};

/**
 * A bottom sheet: slides up over a dimmed page, dismissed by the close
 * button, a tap on the backdrop, Escape, or dragging the grab handle down.
 * The body scrolls; the header and optional footer stay put.
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  tone = 'light',
  tall = false,
  footer,
  testId,
}: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // The page under the sheet must not scroll along with it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const drag = useDragControls();
  if (typeof document === 'undefined') return null;
  const dark = tone === 'dark';

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 120 || info.velocity.y > 600) onClose();
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[55]" data-testid={testId}>
          <motion.div
            className="absolute inset-0"
            style={{ background: 'rgba(15,23,42,0.45)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : undefined}
            className={`m-sheet absolute inset-x-0 bottom-0 mx-auto w-full max-w-[520px] flex flex-col rounded-t-[22px] overflow-hidden ${
              tall ? 'h-[92dvh]' : 'max-h-[88dvh]'
            }`}
            style={{ background: dark ? '#0f0f1a' : '#ffffff' }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 320 }}
            drag="y"
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={onDragEnd}
          >
            {/* Grab handle + header. Dragging starts only here so the body
                can scroll freely. */}
            <div className="flex-shrink-0 touch-none" onPointerDown={(e) => drag.start(e)}>
              <div className="flex justify-center pt-2.5 pb-1">
                <span
                  className="block w-10 h-1.5 rounded-full"
                  style={{ background: dark ? 'rgba(255,255,255,0.22)' : '#d1d5db' }}
                />
              </div>
              <div className="flex items-start gap-3 px-5 pt-1 pb-3">
                <div className="flex-1 min-w-0">
                  <h2 className={`text-[18px] font-semibold leading-tight ${dark ? 'text-white' : 'text-gray-900'}`}>{title}</h2>
                  {subtitle && (
                    <div className={`text-[13px] mt-0.5 ${dark ? 'text-white/55' : 'text-gray-500'}`}>{subtitle}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className={`-mr-2 w-11 h-11 flex-shrink-0 rounded-full flex items-center justify-center ${
                    dark ? 'text-white/70 active:bg-white/10' : 'text-gray-500 active:bg-gray-100'
                  }`}
                >
                  <X size={20} />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{children}</div>
            {footer && <div className="flex-shrink-0">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
