import { describe, it, expect } from "vitest";
import {
  NO_REPLY_GUIDANCE,
  SOUL,
  callerContext,
  soulPrompt
} from "@/agent/prompt";

describe("SOUL", () => {
  it("includes the <turn> provenance awareness rule", () => {
    expect(SOUL.some((line) => line.includes("<turn"))).toBe(true);
  });

  it("tells the model to record durable facts via set_context", () => {
    expect(SOUL.some((line) => line.includes("set_context"))).toBe(true);
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

describe("soulPrompt", () => {
  it("joins the SOUL lines into the frozen identity block (the Session's soul)", () => {
    const p = soulPrompt();
    expect(p.startsWith(SOUL[0])).toBe(true);
    expect(p).toContain(SOUL[SOUL.length - 1]);
  });

  it("leaves the no_reply guidance out of the frozen soul", () => {
    // The loop appends it only until the agent has spoken; once it streams
    // content the tool is withdrawn, so a permanent mention would tempt a call
    // that does nothing and burns a step.
    expect(soulPrompt()).not.toContain("Staying silent is the right default");
    expect(SOUL.some((line) => line.includes("no_reply"))).toBe(false);
  });
});

describe("NO_REPLY_GUIDANCE", () => {
  it("names the tool and the rules the loop actually enforces", () => {
    expect(NO_REPLY_GUIDANCE).toContain("`no_reply`");
    expect(NO_REPLY_GUIDANCE).toContain("ends your turn");
    expect(NO_REPLY_GUIDANCE).toContain("once you have already sent something");
  });
});
