import { describe, it, expect } from "vitest";
import type { Message } from "@a2a-js/sdk";
import { parseTurn, textOf } from "@/agent/messages";

describe("parseTurn", () => {
  it("parses a well-formed <turn> wrapper", () => {
    const t = parseTurn(
      '<turn from="Ada" id="U1" channel="general" at="2026-07-01T00:00:00.000Z">hello there</turn>'
    );
    expect(t).toEqual({
      from: "Ada",
      id: "U1",
      channel: "general",
      at: "2026-07-01T00:00:00.000Z",
      body: "hello there"
    });
  });

  it("unescapes attribute entities", () => {
    const t = parseTurn(
      '<turn from="A &amp; B" id="U1" channel="general" at="x">hi</turn>'
    );
    expect(t?.from).toBe("A & B");
  });

  it("returns null for plain text", () => {
    expect(parseTurn("just a normal message")).toBeNull();
  });

  it("returns null when a required attribute is missing", () => {
    // no `id`
    expect(
      parseTurn('<turn from="Ada" channel="general" at="x">hi</turn>')
    ).toBeNull();
  });
});

describe("textOf", () => {
  it("concatenates text parts and trims", () => {
    const msg = {
      parts: [
        { kind: "text", text: " foo" },
        { kind: "text", text: "bar " }
      ]
    } as unknown as Message;
    expect(textOf(msg)).toBe("foobar");
  });

  it("ignores non-text parts", () => {
    const msg = {
      parts: [
        { kind: "file", file: {} },
        { kind: "text", text: "keep" }
      ]
    } as unknown as Message;
    expect(textOf(msg)).toBe("keep");
  });
});
