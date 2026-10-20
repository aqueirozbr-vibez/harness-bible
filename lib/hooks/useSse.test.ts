import { describe, expect, it } from "vitest";

import { parseFrames } from "@/lib/hooks/useSse";

/*
 * The frame boundary (feature-specs/16 § 5.9). What must not go wrong on the client is exactly this: a frame split
 * across two network reads has to arrive as one event, and half a frame has to wait instead of rendering.
 */

const frame = (id: string, event: string, data: unknown): string => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("parseFrames", () => {
  it("reads whole frames and keeps what is left for the next read", () => {
    const text = frame("1.1", "meta", { ordinal: 1 }) + frame("1.2", "token", { text: "A " }) + "id: 1.3\nevent: token\ndata: {\"text\":\"cl";
    const { frames, rest } = parseFrames(text);
    expect(frames.map((f) => f.event)).toEqual(["meta", "token"]);
    expect(frames[1]?.data).toEqual({ text: "A " });
    expect(frames[0]?.id).toBe("1.1");
    expect(rest).toBe('id: 1.3\nevent: token\ndata: {"text":"cl');
  });

  it("joins a frame that arrived in two pieces", () => {
    const whole = frame("1.1", "final", { kind: "answer" });
    const first = parseFrames(whole.slice(0, 20));
    expect(first.frames).toEqual([]);
    const second = parseFrames(first.rest + whole.slice(20));
    expect(second.frames.map((f) => f.event)).toEqual(["final"]);
    expect(second.frames[0]?.data).toEqual({ kind: "answer" });
    expect(second.rest).toBe("");
  });

  it("drops the keepalive comment and a line that is not the protocol's", () => {
    const { frames } = parseFrames(`: keepalive\n\n${frame("1.1", "status", { step: "drafting" })}event: token\ndata: not json\n\n`);
    expect(frames.map((f) => f.event)).toEqual(["status"]);
  });

  it("reads several frames out of one chunk, in order", () => {
    const { frames } = parseFrames([frame("2.1", "meta", {}), frame("2.2", "token", { text: "a" }), frame("2.3", "token", { text: "b" }), frame("2.4", "final", { kind: "refusal" })].join(""));
    expect(frames.map((f) => f.event)).toEqual(["meta", "token", "token", "final"]);
    expect(frames.map((f) => f.id)).toEqual(["2.1", "2.2", "2.3", "2.4"]);
  });
});
