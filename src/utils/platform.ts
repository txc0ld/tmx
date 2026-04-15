// Synchronous platform detection from navigator — no async/plugin needed
// Returns 'darwin' (macOS), 'win32' (Windows), 'linux', or 'unknown'
export type Platform = 'darwin' | 'win32' | 'linux' | 'unknown';

let cachedPlatform: Platform | null = null;

export function getPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) cachedPlatform = 'darwin';
  else if (/Win/i.test(ua)) cachedPlatform = 'win32';
  else if (/Linux/i.test(ua)) cachedPlatform = 'linux';
  else cachedPlatform = 'unknown';
  return cachedPlatform;
}

export function isMac(): boolean {
  return getPlatform() === 'darwin';
}

export function isWindows(): boolean {
  return getPlatform() === 'win32';
}

// Display the correct modifier symbol for the current platform
export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl';
}

// Display the correct modifier + key combo (e.g., "⌘K" on macOS, "Ctrl+K" on Windows)
export function modShortcut(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl+${key}`;
}
