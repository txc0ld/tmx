/**
 * Direct keyboard capture for xterm.js terminals.
 *
 * xterm's hidden textarea (`left: -9999em; z-index: -5`) cannot receive
 * focus inside WebView2 when nested under a CSS-transformed, overflow-hidden
 * canvas.  Instead of fighting with the textarea, we bypass it entirely:
 *
 *   1. Make the terminal container div focusable (`tabindex="0"`)
 *   2. Capture `keydown` events on the container
 *   3. Translate each key into the terminal escape sequence it represents
 *   4. Write the sequence straight to the PTY via the supplied write fn
 *
 * This gives us full interactive terminal input without relying on
 * xterm's internal focus / textarea plumbing.
 */

/* ------------------------------------------------------------------ */
/*  Key → terminal-sequence translation                                */
/* ------------------------------------------------------------------ */

/** Map a DOM KeyboardEvent to the byte string a VT terminal expects. */
function keyToSequence(e: KeyboardEvent, applicationCursorMode?: boolean): string | null {
  // Pure modifier keys — no terminal data
  const MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'];
  if (MODIFIERS.includes(e.key)) return null;

  // Let OS / browser shortcuts pass through (Cmd+*, Ctrl+Shift+*)
  if (e.metaKey) return null;
  if (e.ctrlKey && e.shiftKey) return null;

  // Ctrl + letter → control character (^A = 0x01 … ^Z = 0x1A)
  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k.length === 1 && k >= 'a' && k <= 'z') {
      return String.fromCharCode(k.charCodeAt(0) - 96);
    }
    switch (k) {
      case ' ':  return '\x00';   // NUL
      case '[':  return '\x1b';   // ESC
      case '\\': return '\x1c';   // FS
      case ']':  return '\x1d';   // GS
      case '/':  return '\x1f';   // US
    }
    return null;
  }

  // Named / special keys
  switch (e.key) {
    case 'Enter':      return '\r';
    case 'Backspace':  return '\x7f';
    case 'Tab':        return e.shiftKey ? '\x1b[Z' : '\t';
    case 'Escape':     return '\x1b';

    case 'ArrowUp':    return applicationCursorMode ? '\x1bOA' : '\x1b[A';
    case 'ArrowDown':  return applicationCursorMode ? '\x1bOB' : '\x1b[B';
    case 'ArrowRight': return applicationCursorMode ? '\x1bOC' : '\x1b[C';
    case 'ArrowLeft':  return applicationCursorMode ? '\x1bOD' : '\x1b[D';

    case 'Home':       return '\x1b[H';
    case 'End':        return '\x1b[F';
    case 'Delete':     return '\x1b[3~';
    case 'Insert':     return '\x1b[2~';
    case 'PageUp':     return '\x1b[5~';
    case 'PageDown':   return '\x1b[6~';

    case 'F1':  return '\x1bOP';
    case 'F2':  return '\x1bOQ';
    case 'F3':  return '\x1bOR';
    case 'F4':  return '\x1bOS';
    case 'F5':  return '\x1b[15~';
    case 'F6':  return '\x1b[17~';
    case 'F7':  return '\x1b[18~';
    case 'F8':  return '\x1b[19~';
    case 'F9':  return '\x1b[20~';
    case 'F10': return '\x1b[21~';
    case 'F11': return '\x1b[23~';
    case 'F12': return '\x1b[24~';
  }

  // Alt + printable → ESC prefix
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
    return '\x1b' + e.key;
  }

  // Regular printable character
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return e.key;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Attach direct keyboard capture to a terminal container element.
 *
 * @param container  The DOM element that wraps the xterm terminal.
 * @param writeToPty Function that sends raw bytes to the PTY.
 * @param terminal   Optional xterm Terminal instance; used to detect application cursor mode.
 * @returns          Cleanup function (call in useEffect teardown).
 */
export function attachKeyboardCapture(
  container: HTMLElement,
  writeToPty: (data: string) => void,
  terminal?: { _core?: { modes?: { applicationCursorKeysMode?: boolean } } },
): () => void {
  // Make the container focusable (no visible outline)
  container.setAttribute('tabindex', '0');
  container.style.outline = 'none';

  const onKeyDown = (e: KeyboardEvent) => {
    // Never intercept typing inside a native <input> / <textarea>
    // (e.g. the agent config bar or runner command input)
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const appCursorMode = terminal?._core?.modes?.applicationCursorKeysMode ?? false;
    const seq = keyToSequence(e, appCursorMode);
    if (seq !== null) {
      writeToPty(seq);
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const text = e.clipboardData?.getData('text');
    if (text) {
      // Bracketed paste so readline-aware programs handle multi-line correctly
      writeToPty('\x1b[200~' + text + '\x1b[201~');
      e.preventDefault();
    }
  };

  // Focus the container when the user clicks anywhere inside it,
  // so subsequent keystrokes are captured.
  const onMouseDown = () => {
    container.focus({ preventScroll: true });
  };

  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('paste', onPaste);
  container.addEventListener('mousedown', onMouseDown);

  return () => {
    container.removeEventListener('keydown', onKeyDown);
    container.removeEventListener('paste', onPaste);
    container.removeEventListener('mousedown', onMouseDown);
  };
}
