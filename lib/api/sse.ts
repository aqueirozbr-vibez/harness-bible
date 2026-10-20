import { errorMessage } from "@/lib/api/messages";
import type { Locale } from "@/lib/i18n/routing";
import { TurnEventSchema, type TurnEventLine } from "@/lib/schemas/workers";

/*
 * The assistant's stream, from the workers' JSON lines to the browser's server-sent events (feature-specs/15
 * § 6.1, § 6.2). The web tier translates and never composes: an event's `data` is the line's own object, so the
 * dock renders citations, substitutions and verdicts from the `final` event alone (invariant 14).
 *
 * Two things are added here and nowhere else. The `id:` of each event is the message ordinal and a counter, so a
 * client that reconnects can say what it saw. And an `error` line's message is replaced by the catalogue's in the
 * reader's language: the workers write a developer's sentence, and a reader's sentence belongs in `messages/`
 * (code-standards § Strings).
 */

/** A comment line every 15 s while the workers are thinking, so a proxy does not close an idle connection (D3). */
export const SSE_KEEPALIVE_MS = 15_000;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  /* nginx buffers a response body by default, which would hold every token until the answer is complete. */
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

export interface SseOptions {
  /** The reader's language, for the one string the translation writes: an error's message. */
  readonly locale: Locale;
  /** Called once with the `final` event's data, which is what a replay of the same `Idempotency-Key` answers (§ 5.3, D1). */
  readonly onFinal?: (data: Record<string, unknown>) => Promise<void>;
  readonly traceId: string;
  readonly keepaliveMs?: number;
}

/** One event, formatted as the protocol writes it: an id, a name, one data line, a blank line. */
export function sseEvent(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function withCatalogueMessage(line: TurnEventLine, locale: Locale): TurnEventLine {
  if (line.event !== "error") return line;
  const code = typeof line.data.code === "string" ? line.data.code : "INTERNAL";
  const fallback = typeof line.data.message === "string" ? line.data.message : "";
  return { event: "error", data: { ...line.data, code, message: errorMessage(code, locale, fallback) } };
}

/**
 * The stream the route returns: the workers' `application/x-ndjson` body, line by line, as server-sent events.
 * A line that is not the protocol's, and a connection that drops mid-turn, both end the stream with one `error`
 * event — never with a half-written answer the reader might take for a whole one.
 */
export function sseFromLines(source: ReadableStream<Uint8Array>, options: SseOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keepaliveMs = options.keepaliveMs ?? SSE_KEEPALIVE_MS;
  let ordinal = 0;
  let counter = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      /* The reader may close the tab mid-turn. Writing to a stream nobody holds throws, and the turn is not the
         browser's to cancel — it finishes server side and the row carries its state (spec 16 § 7) — so a write
         after that point is dropped and the lines are read to the end. */
      let gone = false;
      const write = (text: string): void => {
        if (gone) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          gone = true;
        }
      };
      const send = (line: TurnEventLine): void => {
        counter += 1;
        write(sseEvent(`${String(ordinal)}.${String(counter)}`, line.event, line.data));
      };
      /* A timer rather than a wrapped read: the gap this covers is the workers thinking, not the socket. */
      const keepalive = setInterval(() => write(": keepalive\n\n"), keepaliveMs);
      const reader = source.getReader();
      let buffer = "";
      let ended = false;

      const handle = async (text: string): Promise<void> => {
        const parsed = TurnEventSchema.safeParse(((): unknown => {
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        })());
        if (!parsed.success) {
          send({ event: "error", data: { code: "INTERNAL", message: errorMessage("INTERNAL", options.locale, ""), traceId: options.traceId } });
          ended = true;
          return;
        }
        const line = parsed.data;
        if (line.event === "meta" && typeof line.data.ordinal === "number") ordinal = line.data.ordinal;
        send(withCatalogueMessage(line, options.locale));
        if (line.event === "final") await options.onFinal?.(line.data);
        if (line.event === "final" || line.event === "error") ended = true;
      };

      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let cut = buffer.indexOf("\n");
          while (cut >= 0) {
            const text = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut + 1);
            if (text.length > 0) await handle(text);
            cut = buffer.indexOf("\n");
          }
          if (ended) break;
        }
        const rest = buffer.trim();
        if (!ended && rest.length > 0) await handle(rest);
        /* The workers closed without a verdict: the reader is told the turn did not complete rather than left
           with tokens and no citations, which invariant 14 would make unreadable anyway. */
        if (!ended) send({ event: "error", data: { code: "ASSISTANT_UNAVAILABLE", message: errorMessage("ASSISTANT_UNAVAILABLE", options.locale, ""), traceId: options.traceId } });
      } catch (error: unknown) {
        console.error("assistant stream failed", options.traceId, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        if (!ended) send({ event: "error", data: { code: "ASSISTANT_UNAVAILABLE", message: errorMessage("ASSISTANT_UNAVAILABLE", options.locale, ""), traceId: options.traceId } });
      } finally {
        clearInterval(keepalive);
        reader.releaseLock();
        try {
          controller.close();
        } catch {
          /* Already closed by the client going away; there is nothing left to say. */
        }
      }
    },
  });
}

/**
 * A replay of the same `Idempotency-Key`: the stored `final`, alone, on a stream of the same shape (§ 5.3, D1).
 * The reader's client reads one event and renders the same answer; nothing is asked of a model twice.
 */
export function sseOfStoredFinal(data: unknown, ordinal: number): ReadableStream<Uint8Array> {
  const text = sseEvent(`${String(ordinal)}.1`, "final", data);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
