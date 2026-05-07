import { describe, it, expect } from 'vitest';
import type { RoleCapabilities } from '@/types';
import {
  canonicalJsonHash,
  computeFullFingerprint,
  computeMinimalFingerprint,
  type FullFingerprintInput,
} from './fingerprint';

const baseFullInput = (
  overrides: Partial<FullFingerprintInput> = {},
): FullFingerprintInput => ({
  templateId: 'tx.hello',
  template: { kind: 'pipeline', id: 'tx.hello', name: 'Hello' },
  terminalxVersion: '0.1.0',
  skillContents: {},
  rolePrompts: {},
  roleCapabilities: {},
  ...overrides,
});

const sampleCaps = (): RoleCapabilities => ({
  fileWrites: { allow: ['src/**'], deny: ['.env'] },
  shell: { allowPatterns: ['^pnpm '], denyPatterns: ['^rm '] },
  network: 'package-managers',
  mcpTools: ['github'],
  maxFileSize: 1024,
});

describe('canonicalJsonHash', () => {
  it('produces same hash regardless of key order', async () => {
    const a = await canonicalJsonHash({ b: 1, a: 2 });
    const b = await canonicalJsonHash({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('different content → different hash', async () => {
    const a = await canonicalJsonHash({ x: 1 });
    const b = await canonicalJsonHash({ x: 2 });
    expect(a).not.toBe(b);
  });

  it('returns 64-char hex (sha256)', async () => {
    const h = await canonicalJsonHash({ x: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeMinimalFingerprint', () => {
  it('hashes the template + version', async () => {
    const fp = await computeMinimalFingerprint({
      templateId: 'tx.hello',
      template: { kind: 'pipeline', id: 'tx.hello', name: 'Hello' },
      terminalxVersion: '0.1.0',
    });
    expect(fp.templateId).toBe('tx.hello');
    expect(fp.templateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.terminalxVersion).toBe('0.1.0');
    expect(fp.skillHashes).toEqual({});
  });

  it('same template input → same templateHash', async () => {
    const tpl = { kind: 'pipeline' as const, id: 'tx.hello', name: 'Hello' };
    const a = await computeMinimalFingerprint({ templateId: 'tx.hello', template: tpl, terminalxVersion: '0.1.0' });
    const b = await computeMinimalFingerprint({ templateId: 'tx.hello', template: tpl, terminalxVersion: '0.1.0' });
    expect(a.templateHash).toBe(b.templateHash);
  });
});

describe('computeFullFingerprint', () => {
  it('empty inputs → empty maps and undefined invariantsHash', async () => {
    const fp = await computeFullFingerprint(baseFullInput());
    expect(fp.skillHashes).toEqual({});
    expect(fp.rolePromptHashes).toEqual({});
    expect(fp.capabilityManifests).toEqual({});
    expect(fp.invariantsHash).toBeUndefined();
  });

  it('hashes each skill content as 64-char hex', async () => {
    const fp = await computeFullFingerprint(
      baseFullInput({
        skillContents: {
          'tx-pipeline-stage-handoff': '# Skill content...',
          'tx-pipeline-reviewer': '# Reviewer skill',
        },
      }),
    );
    expect(fp.skillHashes['tx-pipeline-stage-handoff']).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.skillHashes['tx-pipeline-reviewer']).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.skillHashes['tx-pipeline-stage-handoff']).not.toBe(
      fp.skillHashes['tx-pipeline-reviewer'],
    );
  });

  it('same skill content → same skill hash (determinism)', async () => {
    const input = baseFullInput({
      skillContents: { foo: '# identical content\nline 2' },
    });
    const a = await computeFullFingerprint(input);
    const b = await computeFullFingerprint(input);
    expect(a.skillHashes.foo).toBe(b.skillHashes.foo);
  });

  it('different skill content → different skill hash', async () => {
    const a = await computeFullFingerprint(
      baseFullInput({ skillContents: { foo: 'A' } }),
    );
    const b = await computeFullFingerprint(
      baseFullInput({ skillContents: { foo: 'B' } }),
    );
    expect(a.skillHashes.foo).not.toBe(b.skillHashes.foo);
  });

  it('role prompt hash is whitespace-sensitive (no normalization)', async () => {
    const a = await computeFullFingerprint(
      baseFullInput({ rolePrompts: { planner: 'foo' } }),
    );
    const b = await computeFullFingerprint(
      baseFullInput({ rolePrompts: { planner: 'foo ' } }),
    );
    expect(a.rolePromptHashes.planner).toMatch(/^[0-9a-f]{64}$/);
    expect(a.rolePromptHashes.planner).not.toBe(b.rolePromptHashes.planner);
  });

  it('capability manifest is canonical-JSON-hashed (key order independent)', async () => {
    const caps1: RoleCapabilities = sampleCaps();
    // Same content, different surface key order — JS preserves insertion order,
    // so this exercises the canonicalize step inside canonicalJsonHash.
    const caps2: RoleCapabilities = {
      maxFileSize: 1024,
      mcpTools: ['github'],
      network: 'package-managers',
      shell: { denyPatterns: ['^rm '], allowPatterns: ['^pnpm '] },
      fileWrites: { deny: ['.env'], allow: ['src/**'] },
    };
    const a = await computeFullFingerprint(
      baseFullInput({ roleCapabilities: { builder: caps1 } }),
    );
    const b = await computeFullFingerprint(
      baseFullInput({ roleCapabilities: { builder: caps2 } }),
    );
    expect(a.capabilityManifests.builder).toMatch(/^[0-9a-f]{64}$/);
    expect(a.capabilityManifests.builder).toBe(b.capabilityManifests.builder);
  });

  it('invariantsContent: undefined / empty / non-empty', async () => {
    const undef = await computeFullFingerprint(baseFullInput());
    expect(undef.invariantsHash).toBeUndefined();

    const empty = await computeFullFingerprint(baseFullInput({ invariantsContent: '' }));
    expect(empty.invariantsHash).toBeUndefined();

    const nullish = await computeFullFingerprint(baseFullInput({ invariantsContent: null }));
    expect(nullish.invariantsHash).toBeUndefined();

    const present = await computeFullFingerprint(
      baseFullInput({ invariantsContent: '## title' }),
    );
    expect(present.invariantsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('base minimal-fingerprint fields flow through', async () => {
    const fp = await computeFullFingerprint(
      baseFullInput({
        templateId: 'tx.trio',
        template: { kind: 'pipeline', id: 'tx.trio', name: 'Trio' },
        terminalxVersion: '0.2.3',
        claudeVersion: '1.4.0',
        codexVersion: '0.9.1',
      }),
    );
    expect(fp.templateId).toBe('tx.trio');
    expect(fp.templateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.terminalxVersion).toBe('0.2.3');
    expect(fp.claudeVersion).toBe('1.4.0');
    expect(fp.codexVersion).toBe('0.9.1');
    expect(fp.models).toEqual({});
  });
});
