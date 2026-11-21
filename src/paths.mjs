/**
 * Windows long-path helper.
 *
 * MAX_PATH is 260 bytes; Node fails past it unless the path carries the \\
 * prefix. Conversion happens at the I/O boundary only: the index and the UI keep
 * the normal, readable path.
 */
import { resolve, isAbsolute } from 'node:path';

const LIMIT = 240; // leave room for a filename before crossing 260

export function ioPath(p) {
  if (process.platform !== 'win32') return p;
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\')) return p;

  const abs = isAbsolute(p) ? p : resolve(p);
  if (abs.length < LIMIT) return abs;

  if (abs.startsWith('\\\\')) return '\\\\?\\UNC\\' + abs.slice(2).replace(/\//g, '\\');
  return '\\\\?\\' + abs.replace(/\//g, '\\');
}
