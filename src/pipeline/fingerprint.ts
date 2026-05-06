import type { PipelineRole, RoleCapabilities, RunFingerprint } from '@/types';

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

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function canonicalJsonHash(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize(value)));
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

export interface FullFingerprintInput extends MinimalFingerprintInput {
  /** Map of skill name → raw SKILL.md content. */
  skillContents: Record<string, string>;
  /** Map of role → resolved prompt text the agent will receive. */
  rolePrompts: Partial<Record<PipelineRole, string>>;
  /** Map of role → RoleCapabilities object (will be canonical-JSON-hashed). */
  roleCapabilities: Partial<Record<PipelineRole, RoleCapabilities>>;
  /** Optional raw INVARIANTS.md content if present in project root. */
  invariantsContent?: string | null;
}

export async function computeFullFingerprint(
  input: FullFingerprintInput,
): Promise<RunFingerprint> {
  const base = await computeMinimalFingerprint(input);

  const skillHashes: Record<string, string> = {};
  for (const name of Object.keys(input.skillContents).sort()) {
    skillHashes[name] = await sha256Hex(input.skillContents[name]);
  }

  const rolePromptHashes: Partial<Record<PipelineRole, string>> = {};
  for (const role of Object.keys(input.rolePrompts).sort() as PipelineRole[]) {
    const prompt = input.rolePrompts[role];
    if (typeof prompt === 'string') {
      rolePromptHashes[role] = await sha256Hex(prompt);
    }
  }

  const capabilityManifests: Partial<Record<PipelineRole, string>> = {};
  for (const role of Object.keys(input.roleCapabilities).sort() as PipelineRole[]) {
    const caps = input.roleCapabilities[role];
    if (caps) {
      capabilityManifests[role] = await canonicalJsonHash(caps);
    }
  }

  const invariantsHash =
    typeof input.invariantsContent === 'string' && input.invariantsContent.length > 0
      ? await sha256Hex(input.invariantsContent)
      : undefined;

  return {
    ...base,
    skillHashes,
    rolePromptHashes,
    capabilityManifests,
    invariantsHash,
  };
}
