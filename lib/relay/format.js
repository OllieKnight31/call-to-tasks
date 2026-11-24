/** Presentation helpers: every value a notification shows passes through here. */

export const money = (n) => (n == null ? null : `£${Number(n).toLocaleString('en-GB')}`);

const DAY = 86400000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** "12 Sep · in 5 days": the relative half is what makes a date actionable. */
export function dateWithRelative(value, { pastLabel = 'ago' } = {}) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(+d)) return String(value);
  const dateOnly = !String(value).includes('T');
  const shown = d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }),
  });
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / DAY);
  if (days === 0) return `${shown} · today`;
  if (days === 1) return `${shown} · tomorrow`;
  if (days === -1) return `${shown} · yesterday`;
  if (days > 1) return `${shown} · in ${days} days`;
  return `${shown} · ${Math.abs(days)} days ${pastLabel}`;
}

/** How overdue is this, in whole days? Null when there's no date or it isn't past. */
export function overdueDays(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(+d)) return null;
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY);
  return days > 0 ? days : null;
}

export const waLink = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? `https://wa.me/${digits}` : null;
};

export const isUrl = (v) => typeof v === 'string' && /^https?:\/\//.test(v);

/** Flatten Notion blocks to Discord-flavoured markdown, keeping headings. */
export function blocksToText(blocks) {
  const lines = [];
  for (const b of blocks) {
    const rt = b[b.type]?.rich_text;
    const text = rt ? rt.map((t) => t.plain_text).join('').trim() : '';
    switch (b.type) {
      case 'heading_1': case 'heading_2': case 'heading_3':
        if (text) lines.push(`**${text}**`);
        break;
      case 'bulleted_list_item': if (text) lines.push(`• ${text}`); break;
      case 'numbered_list_item': if (text) lines.push(`${lines.length + 1}. ${text}`); break;
      case 'to_do':
        if (text) lines.push(`${b.to_do.checked ? '☑' : '☐'} ${text}`);
        break;
      case 'quote': if (text) lines.push(`> ${text}`); break;
      case 'callout': if (text) lines.push(text); break;
      case 'code': if (text) lines.push(text); break;
      case 'paragraph': case 'toggle': if (text) lines.push(text); break;
      default: break;
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Truncate on a word boundary so a brief never ends mid-word. */
export function clip(text, limit) {
  if (!text) return null;
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  return `${cut.slice(0, at > limit * 0.6 ? at : limit).trimEnd()}…`;
}
