'use client';

import { Loader2 } from 'lucide-react';

/** White rounded section card used by every Settings tab. */
export function SettingsCard({
  title,
  description,
  children,
  tone = 'default',
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
}) {
  return (
    <section
      className={`bg-white rounded-xl border p-6 ${tone === 'danger' ? 'border-red-100' : 'border-gray-100'}`}
    >
      <h2 className={`text-[15px] font-semibold ${tone === 'danger' ? 'text-red-600' : 'text-gray-900'}`}>
        {title}
      </h2>
      {description && <p className="text-[13px] text-gray-500 mt-1">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-gray-700 mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

export const inputClass =
  'w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-900 bg-white outline-none focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15 transition-colors disabled:bg-gray-50 disabled:text-gray-500';

export function PrimaryButton({
  children,
  busy,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-[#2563eb] hover:bg-[#1d4ed8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {busy && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  busy,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium text-gray-700 border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {busy && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

/** On/off switch. Blue when on — the brand colour, no glow. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  id: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div>
        <p id={`${id}-label`} className="text-sm font-medium text-gray-900">
          {label}
        </p>
        {description && <p className="text-[13px] text-gray-500 mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        data-testid={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 mt-0.5 w-10 h-6 rounded-full transition-colors disabled:opacity-50 ${
          checked ? 'bg-[#2563eb]' : 'bg-gray-300'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </button>
    </div>
  );
}

/** Inline status line under a form: green for done, red for errors. */
export function Status({ kind, children }: { kind: 'ok' | 'error'; children: React.ReactNode }) {
  return (
    <p role={kind === 'error' ? 'alert' : 'status'} className={`text-[13px] ${kind === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
      {children}
    </p>
  );
}
