/**
 * Compact custom_id encoding: "<scope>:<action>:<arg>:<arg>..." (max 100 characters).
 * IDs carry only routing data (table id, round sequence, page). Every handler re-validates
 * against server-side state, so a forged or outdated ID can never do more than a real click.
 */

export const ID_SEPARATOR = ':';

export function cid(scope: string, action: string, ...args: (string | number | boolean | null | undefined)[]): string {
  const parts = [scope, action, ...args.map((a) => (a === null || a === undefined ? '' : String(a)))];
  for (const p of parts) {
    if (p.includes(ID_SEPARATOR)) throw new Error(`custom_id part contains separator: ${p}`);
  }
  const id = parts.join(ID_SEPARATOR);
  if (id.length > 100) throw new Error(`custom_id too long (${id.length}): ${id}`);
  return id;
}

export interface ParsedId {
  scope: string;
  action: string;
  args: string[];
}

export function parseCid(id: string): ParsedId {
  const [scope = '', action = '', ...args] = id.split(ID_SEPARATOR);
  return { scope, action, args };
}

export function intArg(value: string | undefined, fallback = 0): number {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : fallback;
}
