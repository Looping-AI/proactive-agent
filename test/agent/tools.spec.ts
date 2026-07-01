import { describe, it, expect } from "vitest";
import { whoami, echo, buildTools } from "@/agent/tools";

describe("whoami", () => {
  it("returns the identity fields, nulling absent ones", () => {
    expect(
      whoami({ displayName: "Ada", slackUserId: "U1", workspaceId: 3 })
    ).toEqual({ displayName: "Ada", slackUserId: "U1", workspaceId: 3 });
    expect(whoami({})).toEqual({
      displayName: null,
      slackUserId: null,
      workspaceId: null
    });
  });
});

describe("echo", () => {
  it("returns the text verbatim", () => {
    expect(echo({ text: "hi" })).toEqual({ text: "hi" });
  });
});

describe("buildTools", () => {
  it("exposes exactly the whoami and echo tools", () => {
    const tools = buildTools({ displayName: "Ada" });
    expect(Object.keys(tools).sort()).toEqual(["echo", "whoami"]);
  });
});
