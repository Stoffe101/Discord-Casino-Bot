/** Tiny helpers for composing SVG strings safely. */

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function n(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function svgDoc(width: number, height: number, body: string, defs = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (defs ? `<defs>${defs}</defs>` : '') +
    body +
    '</svg>';
}

/** Rough text width estimate for layout decisions (Manrope/Cinzel average glyph widths). */
export function textWidth(text: string, size: number, family: 'ui' | 'display' = 'ui'): number {
  const factor = family === 'display' ? 0.72 : 0.58;
  return text.length * size * factor;
}

export function fitText(text: string, size: number, maxWidth: number, family: 'ui' | 'display' = 'ui'): string {
  if (textWidth(text, size, family) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && textWidth(`${out}…`, size, family) > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/** A rounded "pill" badge with centred text. */
export function pill(options: {
  x: number;
  y: number;
  text: string;
  size: number;
  fill: string;
  color: string;
  stroke?: string;
  anchor?: 'start' | 'middle' | 'end';
  weight?: number;
  family?: string;
}): string {
  const padX = options.size * 0.75;
  const w = textWidth(options.text, options.size) + padX * 2;
  const h = options.size * 1.7;
  const anchor = options.anchor ?? 'middle';
  const left = anchor === 'middle' ? options.x - w / 2 : anchor === 'end' ? options.x - w : options.x;
  const top = options.y - h / 2;
  return (
    `<rect x="${n(left)}" y="${n(top)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" fill="${options.fill}"` +
    (options.stroke ? ` stroke="${options.stroke}" stroke-width="1.5"` : '') +
    '/>' +
    `<text x="${n(left + w / 2)}" y="${n(options.y + options.size * 0.36)}" text-anchor="middle" font-family="${options.family ?? 'Manrope'}" font-weight="${options.weight ?? 800}" font-size="${n(options.size)}" fill="${options.color}" letter-spacing="0.5">${esc(options.text)}</text>`
  );
}
