/**
 * Shared PTY/terminal-output cleanup helpers.
 *
 * `cleanPtyOutput` is the high-fidelity scrub used by AgentTile (for piping
 * agent output into other tiles) and the pipeline sentinel scanner. It
 * strips: CSI (colors / cursor), OSC (window title), charset switches, app/
 * numeric mode, normalizes CR/LF, drops other control chars, collapses
 * excessive blank lines.
 *
 * `stripAnsi` is the minimal CSI-only version, kept for callers that just
 * want decolorized text without losing other control bytes.
 */

/* eslint-disable no-control-regex */
const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const OSC = /\x1b\][^\x07]*\x07/g;
const CHARSET = /\x1b[()][0-9A-Z]/g;
const APP_MODE = /\x1b[=>]/g;
const CONTROLS_KEEP_TAB_LF = /[\x00-\x08\x0B-\x1F\x7F]/g;
/* eslint-enable no-control-regex */

export function cleanPtyOutput(raw: string): string {
  return raw
    .replace(CSI, '')
    .replace(OSC, '')
    .replace(CHARSET, '')
    .replace(APP_MODE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(CONTROLS_KEEP_TAB_LF, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function stripAnsi(s: string): string {
  return s.replace(CSI, '');
}
