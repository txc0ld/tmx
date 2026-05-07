import { describe, it, expect } from 'vitest';
import { resolveVerificationChain, type ManifestSet, type Step } from './verification-chain';

describe('resolveVerificationChain', () => {
  it('returns empty chain when no manifests are present (vacuous pass)', () => {
    const result = resolveVerificationChain('/proj', {});
    expect(result).toEqual([]);
  });

  it('returns empty chain for null/undefined manifest fields', () => {
    const manifests: ManifestSet = {
      packageJson: null,
      cargoToml: null,
      pyprojectToml: null,
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([]);
  });

  it('detects pure JS project from package.json scripts (canonical order)', () => {
    const manifests: ManifestSet = {
      packageJson: {
        scripts: {
          format: 'prettier --write .',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
        },
      },
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([
      { kind: 'format', command: 'npm run format' },
      { kind: 'lint', command: 'npm run lint' },
      { kind: 'typecheck', command: 'npm run typecheck' },
      { kind: 'test', command: 'npm run test' },
    ]);
  });

  it('skips JS kinds whose script is missing', () => {
    const manifests: ManifestSet = {
      packageJson: {
        scripts: {
          lint: 'eslint .',
          test: 'vitest run',
        },
      },
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([
      { kind: 'lint', command: 'npm run lint' },
      { kind: 'test', command: 'npm run test' },
    ]);
  });

  it('returns empty chain for package.json with no scripts at all', () => {
    const manifests: ManifestSet = {
      packageJson: { scripts: {} },
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([]);
  });

  it('returns empty chain for package.json with no `scripts` key', () => {
    const manifests: ManifestSet = {
      packageJson: {},
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([]);
  });

  it('detects pure Rust project from Cargo.toml presence', () => {
    const manifests: ManifestSet = {
      cargoToml: '[package]\nname = "thing"\nversion = "0.1.0"\n',
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([
      { kind: 'format', command: 'cargo fmt --check' },
      { kind: 'lint', command: 'cargo clippy --all-targets -- -D warnings' },
      { kind: 'typecheck', command: 'cargo check' },
      { kind: 'test', command: 'cargo test' },
    ]);
  });

  it('detects pure Python project with pytest config and ruff/mypy', () => {
    const manifests: ManifestSet = {
      pyprojectToml: `
[project]
name = "thing"
dependencies = ["ruff", "mypy", "pytest"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`,
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([
      { kind: 'format', command: 'ruff format --check' },
      { kind: 'lint', command: 'ruff check' },
      { kind: 'typecheck', command: 'mypy .' },
      { kind: 'test', command: 'pytest' },
    ]);
  });

  it('detects Python pytest via dependency name even without [tool.pytest]', () => {
    const manifests: ManifestSet = {
      pyprojectToml: `
[project]
dependencies = ["pytest>=7"]
`,
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([
      { kind: 'test', command: 'pytest' },
    ]);
  });

  it('emits no Python steps when pyproject lacks pytest/ruff/mypy', () => {
    const manifests: ManifestSet = {
      pyprojectToml: `
[project]
name = "thing"
dependencies = ["requests"]
`,
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([]);
  });

  it('mixes TS + Rust deterministically (JS first, Rust second, per-ecosystem canonical order)', () => {
    const manifests: ManifestSet = {
      packageJson: {
        scripts: {
          lint: 'eslint .',
          test: 'vitest run',
        },
      },
      cargoToml: '[package]\nname = "thing"\n',
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([
      { kind: 'lint', command: 'npm run lint' },
      { kind: 'test', command: 'npm run test' },
      { kind: 'format', command: 'cargo fmt --check' },
      { kind: 'lint', command: 'cargo clippy --all-targets -- -D warnings' },
      { kind: 'typecheck', command: 'cargo check' },
      { kind: 'test', command: 'cargo test' },
    ]);
  });

  it('mixes JS + Rust + Python in JS → Rust → Python order', () => {
    const manifests: ManifestSet = {
      packageJson: {
        scripts: { test: 'vitest run' },
      },
      cargoToml: '[package]\nname = "x"\n',
      pyprojectToml: '[tool.pytest.ini_options]\n',
    };
    const result = resolveVerificationChain('/proj', manifests);
    const commands = result.map(s => s.command);
    // JS first
    expect(commands.indexOf('npm run test')).toBeLessThan(commands.indexOf('cargo test'));
    // Rust before Python
    expect(commands.indexOf('cargo test')).toBeLessThan(commands.indexOf('pytest'));
    expect(commands).toContain('pytest');
  });

  it('template-override short-circuits auto-detect when non-empty', () => {
    const override: Step[] = [
      { kind: 'test', command: 'just verify' },
    ];
    const manifests: ManifestSet = {
      packageJson: { scripts: { test: 'vitest run' } },
      cargoToml: '[package]\nname = "x"\n',
      templateOverride: override,
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual(override);
  });

  it('empty template-override falls through to auto-detect', () => {
    const manifests: ManifestSet = {
      packageJson: { scripts: { test: 'vitest run' } },
      templateOverride: [],
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([
      { kind: 'test', command: 'npm run test' },
    ]);
  });

  it('ignores unknown package.json scripts (only format/lint/typecheck/test)', () => {
    const manifests: ManifestSet = {
      packageJson: {
        scripts: {
          build: 'tsc',
          dev: 'vite',
          start: 'node .',
          test: 'vitest run',
        },
      },
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([
      { kind: 'test', command: 'npm run test' },
    ]);
  });

  it('treats Cargo.toml without [package] as not-a-rust-project (workspace-only or empty)', () => {
    // A pure workspace Cargo.toml (no [package]) shouldn't yield steps —
    // CI would run from the package dirs, not the workspace root.
    const manifests: ManifestSet = {
      cargoToml: '[workspace]\nmembers = ["a", "b"]\n',
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([]);
  });

  it('Python with only ruff yields format + lint (no typecheck, no test)', () => {
    const manifests: ManifestSet = {
      pyprojectToml: `
[tool.ruff]
line-length = 100
`,
    };
    expect(resolveVerificationChain('/proj', manifests)).toEqual([
      { kind: 'format', command: 'ruff format --check' },
      { kind: 'lint', command: 'ruff check' },
    ]);
  });

  it('returns a fresh array each call (no shared mutable state)', () => {
    const manifests: ManifestSet = {
      packageJson: { scripts: { test: 'vitest run' } },
    };
    const a = resolveVerificationChain('/proj', manifests);
    const b = resolveVerificationChain('/proj', manifests);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
