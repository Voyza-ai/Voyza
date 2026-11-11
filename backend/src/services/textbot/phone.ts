/**
 * Phone normalisation to E.164. Group texting (Twilio and Sendblue) is
 * US/Canada-first, so a bare 10-digit number is read as +1. Anything we can't
 * normalise returns null and is treated as an unknown participant.
 */
export function toE164(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** "+14155550123" → "•••0123" for replies that must not echo full numbers. */
export function maskPhone(e164: string): string {
  return `•••${e164.slice(-4)}`;
}
