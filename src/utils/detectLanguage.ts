/**
 * Map a file path to a Monaco language identifier based on its extension.
 *
 * Single source of truth so EditorTile and DiffTile can't drift.
 * Covers the languages Monaco ships with by default — add new ones here,
 * not inline.
 */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json',
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  rs: 'rust',
  py: 'python',
  go: 'go',
  toml: 'toml',
  yaml: 'yaml', yml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  sql: 'sql',
  xml: 'xml', svg: 'xml',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  dart: 'dart',
  vue: 'vue',
  svelte: 'html',
  dockerfile: 'dockerfile',
};

export function detectLanguage(filePath: string): string {
  if (!filePath) return 'plaintext';
  // Dockerfile has no extension but is common enough to warrant a special case.
  const basename = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (basename === 'dockerfile' || basename.startsWith('dockerfile.')) {
    return 'dockerfile';
  }
  const ext = basename.split('.').pop() ?? '';
  return EXT_TO_LANGUAGE[ext] ?? 'plaintext';
}
