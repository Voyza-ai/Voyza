import type { AskingField } from './api';

/**
 * Which trip fact the planner's reply is asking for, so the chat offers the
 * matching control: a calendar for dates, "Use my location" for where they
 * fly from. The backend says so in `asking`; this reads the question itself
 * when it does not (an older backend, or the model leaving it out).
 *
 * Only the reply's last question counts — "London and Madrid, great combo!
 * When are you thinking of going?" asks about dates, whatever came before.
 */
export function askingFrom(reply: string, asking?: AskingField | null): AskingField | null {
  if (asking) return asking;
  const questions = reply.match(/[^.!?]*\?/g);
  const q = questions?.[questions.length - 1]?.trim() ?? '';
  if (!q) return null;
  // Where from — the same reading as the backend's askedWhereFrom.
  if (/\bfrom\b/i.test(q) && /\b(fly|flying|flight|start|starting|leav\w*|depart\w*|coming|based|home)\b/i.test(q)) {
    return 'origin';
  }
  if (/\b(when|what dates|which dates|travel dates|what month|which month)\b/i.test(q)) return 'dates';
  return null;
}
