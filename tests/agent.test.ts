import { describe, expect, test } from "bun:test";
import { ABS_ATTRS, type Attributes, type Span, type Tracer } from "../src";
import { createAgentTelemetryObserver } from "../src/agent";

describe("agent telemetry", () => {
  test("records correlation data without prompts, payloads, or actor PII", async () => {
    let captured: Attributes | undefined;
    const span: Span = {
      addEvent: () => span,
      end: () => {},
      isRecording: () => true,
      recordException: () => {},
      setAttribute: () => span,
      setAttributes: () => span,
      setStatus: () => span,
      spanContext: () => ({
        traceId: "0".repeat(32),
        spanId: "0".repeat(16),
        traceFlags: 0,
      }),
      updateName: () => span,
    };
    const tracer = {
      startSpan: (_name, options) => {
        captured = options?.attributes;
        return span;
      },
      startActiveSpan: (() => undefined) as Tracer["startActiveSpan"],
    } satisfies Tracer;
    await createAgentTelemetryObserver(tracer)({
      type: "step.appended",
      run: {
        id: "run-1",
        status: "running",
        actor: {
          tenantId: "tenant-1",
          userId: "private-user",
          agentId: "private-agent",
        },
        agent: {
          descriptorId: "https://agent.example",
          descriptorVersion: "1",
          descriptorDigest: "sha256:abc",
        },
        usage: {
          actions: 1,
          costMicros: 2,
          inputTokens: 3,
          outputTokens: 4,
          spendMinor: 5,
          wallTimeMs: 6,
        },
      },
      step: {
        id: "step-1",
        sequence: 1,
        kind: "effect.requested",
        name: "email.send",
      },
    });
    expect(captured?.[ABS_ATTRS.agentRunId]).toBe("run-1");
    expect(captured?.[ABS_ATTRS.agentEffectName]).toBe("email.send");
    expect(captured?.[ABS_ATTRS.agentActorUserId]).toBeUndefined();
    expect(JSON.stringify(captured)).not.toContain("private-user");
  });
});
