import { describe, it, expect } from 'vitest';
import { canonicalJsonHash, computeMinimalFingerprint } from './fingerprint';

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
