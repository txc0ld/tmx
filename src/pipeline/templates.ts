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
