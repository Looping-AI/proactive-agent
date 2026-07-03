import { describe, it, expect } from "vitest";
import { whoami, echo, buildTools, recall } from "@/agent/tools";
import type { RecallDeps } from "@/agent/tools";
import type { RecallIndex } from "@/agent/recall";

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

/** Recall deps backed by a fake index returning one canned match. */
function recallDeps(hasArchive: boolean): RecallDeps {
  const index: RecallIndex = {
    async upsert() {
      return { ids: [], count: 0 };
    },
    async query() {
      return {
        matches: [
          {
            id: "m1",
            score: 0.8,
            metadata: { role: "user", text: "teal is my favorite" }
          } as VectorizeMatch
        ],
        count: 1
      };
    }
  };
  return {
    index,
    namespace: "ns:1",
    embed: async (texts) => texts.map(() => [0, 1, 2]),
    hasArchive
  };
}

describe("recall", () => {
  it("returns the archived matches when there is an archive", async () => {
    const out = await recall(recallDeps(true), { query: "favorite color" });
    expect(out.note).toBeUndefined();
    expect(out.results).toEqual([
      { score: 0.8, role: "user", text: "teal is my favorite" }
    ]);
  });

  it("returns an empty note when nothing has been archived yet", async () => {
    const out = await recall(recallDeps(false), { query: "anything" });
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/no older history/i);
  });
});

describe("buildTools", () => {
  it("exposes exactly the whoami and echo tools by default", () => {
    const tools = buildTools({ name: "Demo Agent" });
    expect(Object.keys(tools).sort()).toEqual(["echo", "whoami"]);
  });

  it("omits recall until this caller has compacted at least once", () => {
    const tools = buildTools({ name: "Demo Agent" }, recallDeps(false));
    expect(Object.keys(tools).sort()).toEqual(["echo", "whoami"]);
  });

  it("adds the recall tool once an archive exists", () => {
    const tools = buildTools({ name: "Demo Agent" }, recallDeps(true));
    expect(Object.keys(tools).sort()).toEqual(["echo", "recall", "whoami"]);
  });
});
