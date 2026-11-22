/**
 * Loads Node's built-in SQLite driver (node:sqlite).
 *
 * We use the built-in driver instead of a native addon so that `npm install` never needs a
 * C++ toolchain on Windows. Node 24 still labels the module "experimental" and prints a
 * one-time ExperimentalWarning; we silence exactly that warning (and nothing else) here.
 */
type EmitWarning = typeof process.emitWarning;

const originalEmitWarning: EmitWarning = process.emitWarning;
const filteredEmitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (typeof message === 'string' && message.includes('SQLite is an experimental feature')) return;
  (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
} as EmitWarning;

process.emitWarning = filteredEmitWarning;
const sqlite = await import('node:sqlite');
process.emitWarning = originalEmitWarning;

export const { DatabaseSync } = sqlite;
export type DatabaseSync = InstanceType<typeof sqlite.DatabaseSync>;
export type StatementSync = ReturnType<DatabaseSync['prepare']>;
