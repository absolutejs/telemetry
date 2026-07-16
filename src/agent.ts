import {
  ABS_ATTRS,
  SpanStatusCode,
  type Attributes,
  type Tracer,
} from "./index";

export type AgentTelemetryRun = {
  id: string;
  parentRunId?: string;
  status: string;
  actor: {
    tenantId: string;
    userId: string;
    agentId: string;
    delegationId?: string;
  };
  agent: {
    descriptorId: string;
    descriptorVersion: string;
    descriptorDigest: string;
  };
  usage: {
    actions: number;
    costMicros: number;
    inputTokens: number;
    outputTokens: number;
    spendMinor: number;
    wallTimeMs: number;
  };
};

export type AgentTelemetryStep = {
  id: string;
  sequence: number;
  kind: string;
  name?: string;
};

export type AgentTelemetryEvent =
  | { type: "run.created"; run: AgentTelemetryRun }
  | { type: "run.claimed"; run: AgentTelemetryRun }
  | { type: "run.transitioned"; run: AgentTelemetryRun }
  | {
      type: "step.appended";
      run: AgentTelemetryRun;
      step: AgentTelemetryStep;
    };

export type AgentTelemetryOptions = {
  /** Actor user and agent identifiers are omitted by default to reduce PII. */
  includeActorIds?: boolean;
  additionalAttributes?: (event: AgentTelemetryEvent) => Attributes;
};

export const agentRunAttributes = (
  run: AgentTelemetryRun,
  options: Pick<AgentTelemetryOptions, "includeActorIds"> = {},
): Attributes => ({
  [ABS_ATTRS.agentRunId]: run.id,
  [ABS_ATTRS.agentParentRunId]: run.parentRunId,
  [ABS_ATTRS.agentStatus]: run.status,
  [ABS_ATTRS.agentDescriptorId]: run.agent.descriptorId,
  [ABS_ATTRS.agentDescriptorVersion]: run.agent.descriptorVersion,
  [ABS_ATTRS.agentDescriptorDigest]: run.agent.descriptorDigest,
  [ABS_ATTRS.agentActorTenantId]: run.actor.tenantId,
  [ABS_ATTRS.agentActorUserId]: options.includeActorIds
    ? run.actor.userId
    : undefined,
  [ABS_ATTRS.agentActorAgentId]: options.includeActorIds
    ? run.actor.agentId
    : undefined,
  [ABS_ATTRS.agentDelegationId]: run.actor.delegationId,
  [ABS_ATTRS.agentBudgetActions]: run.usage.actions,
  [ABS_ATTRS.agentBudgetCostMicros]: run.usage.costMicros,
  [ABS_ATTRS.agentBudgetInputTokens]: run.usage.inputTokens,
  [ABS_ATTRS.agentBudgetOutputTokens]: run.usage.outputTokens,
  [ABS_ATTRS.agentBudgetSpendMinor]: run.usage.spendMinor,
  [ABS_ATTRS.agentBudgetWallTimeMs]: run.usage.wallTimeMs,
});

export const agentEventAttributes = (
  event: AgentTelemetryEvent,
  options: AgentTelemetryOptions = {},
): Attributes => ({
  ...agentRunAttributes(event.run, options),
  ...(event.type === "step.appended"
    ? {
        [ABS_ATTRS.agentStepId]: event.step.id,
        [ABS_ATTRS.agentStepSequence]: event.step.sequence,
        [ABS_ATTRS.agentStepKind]: event.step.kind,
        [ABS_ATTRS.agentEffectName]: event.step.name,
      }
    : {}),
  ...options.additionalAttributes?.(event),
});

/**
 * Creates an `onEvent` callback structurally compatible with
 * `@absolutejs/agent-runtime`. Goal, prompts, inputs, outputs, and effect
 * payloads are never recorded by this adapter.
 */
export const createAgentTelemetryObserver =
  (tracer: Tracer, options: AgentTelemetryOptions = {}) =>
  async (event: AgentTelemetryEvent): Promise<void> => {
    const attributes = agentEventAttributes(event, options);
    const span = tracer.startSpan(`agent.${event.type}`, { attributes });
    span.addEvent(event.type, attributes);
    span.setStatus({
      code:
        event.run.status === "failed"
          ? SpanStatusCode.ERROR
          : SpanStatusCode.OK,
    });
    span.end();
  };
