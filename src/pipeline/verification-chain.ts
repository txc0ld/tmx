/**
 * Verification-chain resolver — pure function mapping a project's manifest set
 * to an ordered list of CI commands (format → lint → typecheck → test).
 *
 * Spec: docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md §4.4
 *
 * No fs / IPC inside — the caller (Rust IPC `pipeline_run_verification_step`)
 * reads the manifests and passes parsed contents in.
 */

export type StepKind = 'format' | 'lint' | 'typecheck' | 'test';

export interface Step {
  kind: StepKind;
  command: string;
}

export interface ManifestSet {
  /** Parsed package.json contents (only `scripts` is consulted). */
  packageJson?: { scripts?: Record<string, string> } | null;
  /** Raw Cargo.toml text. Substring-detected for `[package]`. */
  cargoToml?: string | null;
  /** Raw pyproject.toml text. Substring-detected for pytest/ruff/mypy. */
  pyprojectToml?: string | null;
  /** When non-empty, returned verbatim — auto-detect is bypassed. */
  templateOverride?: Step[];
}

const KIND_ORDER: readonly StepKind[] = ['format', 'lint', 'typecheck', 'test'];

function jsSteps(pkg: NonNullable<ManifestSet['packageJson']>): Step[] {
  const scripts = pkg.scripts ?? {};
  const out: Step[] = [];
  for (const kind of KIND_ORDER) {
    if (typeof scripts[kind] === 'string' && scripts[kind].length > 0) {
      out.push({ kind, command: `npm run ${kind}` });
    }
  }
  return out;
}

function rustSteps(cargoToml: string): Step[] {
  // Workspace-only Cargo.toml (no [package]) shouldn't yield steps —
  // CI runs from package dirs, not the workspace root.
  if (!/^\s*\[package\]/m.test(cargoToml)) return [];
  return [
    { kind: 'format', command: 'cargo fmt --check' },
    { kind: 'lint', command: 'cargo clippy --all-targets -- -D warnings' },
    { kind: 'typecheck', command: 'cargo check' },
    { kind: 'test', command: 'cargo test' },
  ];
}

function pythonSteps(pyproject: string): Step[] {
  // Spec §4.4 example uses `ruff check --select I` for format; we emit
  // `ruff format --check` instead — the actual formatter, not import-sort.
  const out: Step[] = [];
  const hasRuff = /\bruff\b/.test(pyproject);
  const hasMypy = /\bmypy\b/.test(pyproject);
  const hasPytest = /\bpytest\b/.test(pyproject);
  if (hasRuff) {
    out.push({ kind: 'format', command: 'ruff format --check' });
    out.push({ kind: 'lint', command: 'ruff check' });
  }
  if (hasMypy) {
    out.push({ kind: 'typecheck', command: 'mypy .' });
  }
  if (hasPytest) {
    out.push({ kind: 'test', command: 'pytest' });
  }
  return out;
}

export function resolveVerificationChain(
  _projectDir: string,
  manifests: ManifestSet,
): Step[] {
  if (manifests.templateOverride && manifests.templateOverride.length > 0) {
    return manifests.templateOverride.slice();
  }

  const steps: Step[] = [];
  if (manifests.packageJson) steps.push(...jsSteps(manifests.packageJson));
  if (manifests.cargoToml) steps.push(...rustSteps(manifests.cargoToml));
  if (manifests.pyprojectToml) steps.push(...pythonSteps(manifests.pyprojectToml));
  return steps;
}
