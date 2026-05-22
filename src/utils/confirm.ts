import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';

export interface ConfirmActionOptions {
  title?: string;
  kind?: 'info' | 'warning' | 'error';
  okLabel?: string;
  cancelLabel?: string;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function confirmAction(
  message: string,
  options: ConfirmActionOptions = {},
): Promise<boolean> {
  if (!isTauriRuntime()) {
    return window.confirm(message);
  }

  try {
    return await tauriConfirm(message, {
      title: options.title ?? 'TerminalX',
      kind: options.kind ?? 'warning',
      okLabel: options.okLabel,
      cancelLabel: options.cancelLabel,
    });
  } catch (err) {
    console.warn('[dialog] confirm failed:', err);
    return false;
  }
}
