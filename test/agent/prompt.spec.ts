import { describe, it, expect } from "vitest";
import { SOUL, callerContext, systemPrompt } from "@/agent/prompt";

describe("SOUL", () => {
  it("includes the <turn> provenance awareness rule", () => {
    expect(SOUL.some((line) => line.includes("<turn"))).toBe(true);
  });
});

describe("callerContext", () => {
  it("names displayName with slackUserId when both are present", () => {
    expect(callerContext({ displayName: "Ada", slackUserId: "U1" })).toContain(
      "Current caller: Ada (U1)."
    );
  });

  it("uses slackUserId alone when displayName is absent", () => {
    expect(callerContext({ slackUserId: "U9" })).toContain(
      "Current caller: U9."
    );
  });

  it("reports an unknown caller when the identity is empty", () => {
    expect(callerContext({})).toContain("unknown");
  });

  it("includes the workspace when present", () => {
    expect(callerContext({ displayName: "Ada", workspaceId: 7 })).toContain(
      "Slack workspace: 7."
    );
  });
});

describe("systemPrompt", () => {
  it("starts with the soul then appends the caller context", () => {
    const p = systemPrompt({ displayName: "Ada" });
    expect(p.startsWith(SOUL[0])).toBe(true);
    expect(p).toContain("Current caller: Ada.");
  });
});
