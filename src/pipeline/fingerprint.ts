import type { RunFingerprint } from '@/types';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export async function canonicalJsonHash(value: unknown): Promise<string> {
  const json = JSON.stringify(canonicalize(value));
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface MinimalFingerprintInput {
  templateId: string;
  template: unknown;
  terminalxVersion: string;
  claudeVersion?: string;
  codexVersion?: string;
}

export async function computeMinimalFingerprint(
  input: MinimalFingerprintInput,
): Promise<RunFingerprint> {
  return {
    templateId: input.templateId,
    templateHash: await canonicalJsonHash(input.template),
    skillHashes: {},
    rolePromptHashes: {},
    models: {},
    capabilityManifests: {},
    terminalxVersion: input.terminalxVersion,
    claudeVersion: input.claudeVersion,
    codexVersion: input.codexVersion,
  };
}
