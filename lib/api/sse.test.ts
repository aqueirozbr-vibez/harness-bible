import { describe, expect, it, vi } from "vitest";

import { sseEvent, sseFromLines, sseOfStoredFinal } from "@/lib/api/sse";

/*
 * The translation from the workers' JSON lines to the browser's events (feature-specs/15 § 6.1, § 6.2). What these
 * cases hold to is that the web tier adds only two things — the event id and the reader's own error sentence — and
 * that a stream always ends with a verdict: a `final`, or an `error` saying why there is none.
 */

/** A source of NDJSON, optionally in awkward chunks: a line split across two reads is the normal case on a socket. */
function source(chunks: ReadonlyArray<string>, gapMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      controller.enqueue(encoder.encode(chunks[index] ?? ""));
      index += 1;
    },
  });
}

const line = (event: string, data: unknown): string => `${JSON.stringify({ event, data })}\n`;

async function textOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function framesOf(text: string): ReadonlyArray<{ readonly id: string; readonly event: string; readonly data: Record<string, unknown> }> {
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").filter((row) => row.length > 0 && !row.startsWith(":")))
    .filter((rows) => rows.length > 0)
    .map((rows) => ({
      id: rows.find((row) => row.startsWith("id: "))?.slice(4) ?? "",
      event: rows.find((row) => row.startsWith("event: "))?.slice(7) ?? "",
      data: JSON.parse(rows.find((row) => row.startsWith("data: "))?.slice(6) ?? "{}") as Record<string, unknown>,
    }));
}

describe("sseEvent", () => {
  it("writes an id, a name, one data line and the blank line that ends the frame", () => {
    expect(sseEvent("3.1", "token", { text: "a" })).toBe('id: 3.1\nevent: token\ndata: {"text":"a"}\n\n');
  });
});

describe("sseFromLines", () => {
  it("numbers the events with the message ordinal and a counter, in the order the workers wrote them", async () => {
    const onFinal = vi.fn();
    const text = await textOf(
      sseFromLines(
        source([
          line("meta", { messageId: "m1", ordinal: 7 }),
          line("status", { step: "retrieving" }) + line("token", { text: "A " }),
          line("token", { text: "claim." }) + line("final", { kind: "answer", messageId: "m2" }),
        ]),
        { locale: "en", traceId: "a".repeat(32), onFinal },
      ),
    );

    const frames = framesOf(text);
    expect(frames.map((frame) => frame.event)).toEqual(["meta", "status", "token", "token", "final"]);
    /* The ordinal comes from `meta` and is read before that event goes out, so every id of the turn carries it. */
    expect(frames.map((frame) => frame.id)).toEqual(["7.1", "7.2", "7.3", "7.4", "7.5"]);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith({ kind: "answer", messageId: "m2" });
  });

  it("carries a line split across two reads as one event", async () => {
    const text = await textOf(sseFromLines(source(['{"event":"final","data":{"kind"', ':"answer"}}\n']), { locale: "en", traceId: "b".repeat(32) }));
    expect(framesOf(text)).toEqual([{ id: "0.1", event: "final", data: { kind: "answer" } }]);
  });

  it("writes the reader's own sentence for an error, in their language, and keeps the code and the reset", async () => {
    const en = framesOf(await textOf(sseFromLines(source([line("error", { code: "ASSISTANT_UNAVAILABLE", message: "gateway: server", traceId: "c".repeat(32) })]), { locale: "en", traceId: "c".repeat(32) })));
    expect(en[0]?.data).toEqual({ code: "ASSISTANT_UNAVAILABLE", message: "The assistant is unavailable; the answer was not written.", traceId: "c".repeat(32) });

    const pt = framesOf(await textOf(sseFromLines(source([line("error", { code: "BUDGET_EXCEEDED", message: "spent", traceId: "c".repeat(32), resetsAt: "2026-10-01T00:00:00.000Z" })]), { locale: "pt", traceId: "c".repeat(32) })));
    expect(pt[0]?.data).toMatchObject({ code: "BUDGET_EXCEEDED", message: "O orçamento de modelo desta organização foi atingido.", resetsAt: "2026-10-01T00:00:00.000Z" });
  });

  it("ends the stream with an error when a line is not the protocol's, and writes nothing after it", async () => {
    const frames = framesOf(await textOf(sseFromLines(source(["not json\n", line("final", { kind: "answer" })]), { locale: "en", traceId: "d".repeat(32) })));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("error");
    expect(frames[0]?.data.code).toBe("INTERNAL");
  });

  it("ends the stream with an error when the workers close without a verdict", async () => {
    const frames = framesOf(await textOf(sseFromLines(source([line("meta", { ordinal: 1 }), line("token", { text: "half" })]), { locale: "en", traceId: "e".repeat(32) })));
    expect(frames.map((frame) => frame.event)).toEqual(["meta", "token", "error"]);
    expect(frames.at(-1)?.data.code).toBe("ASSISTANT_UNAVAILABLE");
  });

  it("writes a comment line while the workers are thinking, so a proxy keeps the connection", async () => {
    const text = await textOf(sseFromLines(source([line("meta", { ordinal: 1 }), line("final", { kind: "answer" })], 40), { locale: "en", traceId: "f".repeat(32), keepaliveMs: 5 }));
    expect(text).toContain(": keepalive");
    expect(framesOf(text).map((frame) => frame.event)).toEqual(["meta", "final"]);
  });

  it("does not call onFinal for a turn that ended in an error", async () => {
    const onFinal = vi.fn();
    await textOf(sseFromLines(source([line("meta", { ordinal: 1 }), line("error", { code: "INTERNAL", message: "x", traceId: "0".repeat(32) })]), { locale: "en", traceId: "0".repeat(32), onFinal }));
    expect(onFinal).not.toHaveBeenCalled();
  });
});

describe("sseOfStoredFinal", () => {
  it("replays the stored final as a stream of one event", async () => {
    const frames = framesOf(await textOf(sseOfStoredFinal({ kind: "answer", ordinal: 4 }, 4)));
    expect(frames).toEqual([{ id: "4.1", event: "final", data: { kind: "answer", ordinal: 4 } }]);
  });
});

describe("a reader who leaves mid-turn", () => {
  it("stops writing and reads the workers' lines to the end, so the turn still completes", async () => {
    const onFinal = vi.fn();
    const stream = sseFromLines(
      source([line("meta", { ordinal: 1 }), line("token", { text: "half" }), line("final", { kind: "answer" })]),
      { locale: "en", traceId: "1".repeat(32), onFinal },
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    /* The claim is completed even though nobody is listening: the row and the ledger record are the turn's record,
       and a reader who comes back reads them (feature-specs/15 § 6.1). */
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledTimes(1));
  });
});
