const numberFormat = new Intl.NumberFormat('en-US');

export function chips(amount: number): string {
  return numberFormat.format(amount);
}

export function signedChips(amount: number): string {
  if (amount > 0) return `+${numberFormat.format(amount)}`;
  if (amount < 0) return `−${numberFormat.format(Math.abs(amount))}`;
  return '±0';
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${numberFormat.format(count)} ${count === 1 ? singular : pluralForm}`;
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Discord dynamic timestamp markup — rendered in each viewer's own timezone. */
export function discordTime(ms: number, style: 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R' = 'R'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function durationShort(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Escape Discord markdown in user-provided text (names, table names). */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|>#[\]()-])/g, '\\$1').replace(/@/g, '@\u200b');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Strip characters that our bundled fonts cannot draw (emoji, astral symbols, controls). */
export function fontSafe(text: string, fallback = 'Player'): string {
  const cleaned = Array.from(text.normalize('NFKC'))
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp >= 0x20 && cp < 0x2000 && cp !== 0x7f;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
