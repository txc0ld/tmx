import type { PipelineTemplate } from '@/stores/templateStore';

export function helloWorldTemplate(): PipelineTemplate {
  return {
    kind: 'pipeline',
    id: 'tx.pipeline.hello-world',
    name: 'Pipeline: Hello World',
    description: 'Phase 1 smoke template — lays down 3 agent tiles + a controller; walks the state machine to done without spawning agents.',
    isBuiltin: true,

    tiles: [
      { role: 'planner',  type: 'agent', position: { x: 0,    y: 0, w: 480, h: 380 },
        config: { agent: 'claude', model: 'opus-4-7', effort: 'high', mode: 'planner-stub' } },
      { role: 'builder',  type: 'agent', position: { x: 520,  y: 0, w: 480, h: 380 },
        config: { agent: 'claude', model: 'sonnet-4-6', effort: 'low', mode: 'builder-stub' } },
      { role: 'reviewer', type: 'agent', position: { x: 1040, y: 0, w: 480, h: 380 },
        config: { agent: 'claude', model: 'opus-4-7', effort: 'high', mode: 'reviewer-stub' } },
      { role: 'controller', type: 'pipeline-controller', position: { x: 0, y: 420, w: 1520, h: 200 },
        config: {} },
    ],

    wires: [
      { fromRole: 'planner',  toRole: 'builder',  wireType: 'agent-chain' },
      { fromRole: 'builder',  toRole: 'reviewer', wireType: 'agent-chain' },
      { fromRole: 'reviewer', toRole: 'builder',  wireType: 'task-assign' },
    ],

    pipeline: {
      retryBudget: { reviewerReject: 3, ciFail: 3 },
      dualReviewer: false,
      requireMergeGate: true,
      skillBindings: {
        planner:  ['superpowers:brainstorming', 'superpowers:writing-plans', 'tx-pipeline-stage-handoff'],
        builder:  ['superpowers:executing-plans', 'superpowers:test-driven-development', 'tdd', 'superpowers:verification-before-completion', 'tx-pipeline-stage-handoff'],
        reviewer: ['superpowers:requesting-code-review', 'karpathy-guidelines', 'tx-pipeline-reviewer'],
      },
    },
  };
}

/**
 * The production "Anthropic Trio": Opus Planner, Sonnet Builder, Opus
 * Reviewer. Skill-bound per spec §10. Used as the default user-facing
 * pipeline template once Phase 2b ships live execution.
 *
 * Phase 2b wires the skills + sentinel protocol; Phase 2c adds the full
 * role-prompt content (capability scoping, INVARIANTS.md awareness, etc.)
 * The shape is identical to helloWorldTemplate() so the controller doesn't
 * need to discriminate between them at runtime.
 */
export function anthropicTrioTemplate(): PipelineTemplate {
  return {
    kind: 'pipeline',
    id: 'tx.pipeline.anthropic-trio',
    name: 'Anthropic Trio',
    description: 'Plan → Build → Review with Opus Planner, Sonnet Builder, and Opus Reviewer. Bundled skills enforce stage-handoff protocol and reviewer discipline.',
    isBuiltin: true,

    tiles: [
      { role: 'planner', type: 'agent', position: { x: 0, y: 0, w: 480, h: 380 },
        config: {
          agent: 'claude', model: 'opus-4-7', effort: 'high', mode: 'planner',
        } },
      { role: 'builder', type: 'agent', position: { x: 520, y: 0, w: 480, h: 380 },
        config: {
          agent: 'claude', model: 'sonnet-4-6', effort: 'medium', mode: 'builder',
        } },
      { role: 'reviewer', type: 'agent', position: { x: 1040, y: 0, w: 480, h: 380 },
        config: {
          agent: 'claude', model: 'opus-4-7', effort: 'high', mode: 'reviewer',
          oneshot: true,
        } },
      { role: 'controller', type: 'pipeline-controller', position: { x: 0, y: 420, w: 1520, h: 200 },
        config: {} },
    ],

    wires: [
      { fromRole: 'planner',  toRole: 'builder',  wireType: 'agent-chain' },
      { fromRole: 'builder',  toRole: 'reviewer', wireType: 'agent-chain' },
      { fromRole: 'reviewer', toRole: 'builder',  wireType: 'task-assign' },
    ],

    pipeline: {
      retryBudget: { reviewerReject: 3, ciFail: 3 },
      dualReviewer: false,
      requireMergeGate: true,
      skillBindings: {
        planner: [
          'superpowers:brainstorming',
          'superpowers:writing-plans',
          'tx-pipeline-stage-handoff',
        ],
        builder: [
          'superpowers:executing-plans',
          'superpowers:test-driven-development',
          'tdd',
          'superpowers:verification-before-completion',
          'tx-pipeline-stage-handoff',
        ],
        reviewer: [
          'superpowers:requesting-code-review',
          'karpathy-guidelines',
          'tx-pipeline-reviewer',
        ],
      },
    },
  };
}
