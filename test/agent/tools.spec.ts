import { describe, it, expect } from "vitest";
import { whoami, echo, buildTools } from "@/agent/tools";

describe("whoami", () => {
  it("returns the identity fields, nulling absent ones", () => {
    expect(
      whoami({
        key: "custom:3:demo",
        name: "Demo Agent",
        kind: "custom",
        workspaceId: 3
      })
    ).toEqual({
      key: "custom:3:demo",
      name: "Demo Agent",
      kind: "custom",
      workspaceId: 3
    });
    expect(whoami({})).toEqual({
      key: null,
      name: null,
      kind: null,
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
    const tools = buildTools({ name: "Demo Agent" });
    expect(Object.keys(tools).sort()).toEqual(["echo", "whoami"]);
  });
});
