import { describe, it, expect } from "vitest";
import { SOUL, callerContext, systemPrompt } from "@/agent/prompt";

describe("SOUL", () => {
  it("includes the <turn> provenance awareness rule", () => {
    expect(SOUL.some((line) => line.includes("<turn"))).toBe(true);
  });
});

describe("callerContext", () => {
  it("names the agent instance with its kind when both are present", () => {
    expect(callerContext({ name: "Demo Agent", kind: "custom" })).toContain(
      "Calling agent instance: Demo Agent (custom)."
    );
  });

  it("falls back to the instance key when name is absent", () => {
    expect(callerContext({ key: "custom:0:demo" })).toContain(
      "Calling agent instance: custom:0:demo."
    );
  });

  it("reports an unknown caller when the identity is empty", () => {
    expect(callerContext({})).toContain("unknown");
  });

  it("includes the workspace when present", () => {
    expect(callerContext({ name: "Demo Agent", workspaceId: 7 })).toContain(
      "Slack workspace: 7."
    );
  });
});

describe("systemPrompt", () => {
  it("starts with the soul then appends the caller context", () => {
    const p = systemPrompt({ name: "Demo Agent" });
    expect(p.startsWith(SOUL[0])).toBe(true);
    expect(p).toContain("Calling agent instance: Demo Agent.");
  });
});
