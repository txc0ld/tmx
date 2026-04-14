import { convertFileSrc } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';

// Common icon/favicon locations in repos, checked in priority order
const ICON_CANDIDATES = [
  'favicon.ico',
  'favicon.png',
  'favicon.svg',
  'public/favicon.ico',
  'public/favicon.png',
  'public/favicon.svg',
  'public/logo.png',
  'public/logo.svg',
  'public/icon.png',
  'assets/icon.png',
  'assets/logo.png',
  'src/assets/logo.png',
  'src/assets/icon.png',
  '.github/icon.png',
  'icon.png',
  'logo.png',
  'logo.svg',
];

const iconCache = new Map<string, string | null>();

/**
 * Resolve a project icon from common favicon/logo locations in the repo.
 * Returns a webview-loadable URL or null if nothing found.
 */
export async function resolveProjectIcon(cwd: string): Promise<string | null> {
  if (iconCache.has(cwd)) return iconCache.get(cwd)!;

  const sep = cwd.includes('/') ? '/' : '\\';

  for (const candidate of ICON_CANDIDATES) {
    const fullPath = cwd + sep + candidate.replace(/\//g, sep);
    try {
      const found = await exists(fullPath);
      if (found) {
        const url = convertFileSrc(fullPath);
        iconCache.set(cwd, url);
        return url;
      }
    } catch {
      // File doesn't exist or access denied — skip
    }
  }

  iconCache.set(cwd, null);
  return null;
}
