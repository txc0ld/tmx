export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/';
  let out = base.replace(/[\\/]+$/, '');
  for (const raw of parts) {
    const part = raw.replace(/^[\\/]+|[\\/]+$/g, '').replace(/[\\/]+/g, sep);
    if (!part) continue;
    out = out ? `${out}${sep}${part}` : part;
  }
  return out;
}
