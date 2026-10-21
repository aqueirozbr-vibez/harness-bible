import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * A stand-in for the collector (feature-specs/21 § 13.4): an HTTP server that takes OTLP/HTTP JSON on `/v1/traces`
 * and keeps the spans it was sent, flattened to what a test asserts on. It answers as a collector does, so the
 * exporter under test behaves as it would in production; nothing here is a double of the exporter itself.
 */

export interface ReceivedSpan {
  /** The resource's `service.name`: which process sent it. */
  readonly service: string;
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  /** Empty for a root span. */
  readonly parentSpanId: string;
  /** OTLP's SpanKind: 1 internal, 2 server, 3 client. */
  readonly kind: number;
  /** Milliseconds between the span's start and its end. */
  readonly ms: number;
  readonly attributes: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>;
  /** OTLP's status code: 0 unset, 2 error; and the message, when there is one. */
  readonly status: { readonly code: number; readonly message: string };
}

export interface OtlpReceiver {
  /** The value of `OTEL_EXPORTER_OTLP_ENDPOINT` that reaches this receiver. */
  readonly url: string;
  readonly spans: () => ReadonlyArray<ReceivedSpan>;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

interface OtlpValue {
  readonly stringValue?: string;
  readonly intValue?: number | string;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
  /* a list, a trace's tags (feature-specs/49 § 6.4) */
  readonly arrayValue?: { readonly values?: ReadonlyArray<OtlpValue> };
}

interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string | number;
  readonly endTimeUnixNano: string | number;
  readonly attributes?: ReadonlyArray<{ readonly key: string; readonly value: OtlpValue }>;
  readonly status?: { readonly code?: number; readonly message?: string };
}

interface OtlpBody {
  readonly resourceSpans?: ReadonlyArray<{
    readonly resource?: { readonly attributes?: ReadonlyArray<{ readonly key: string; readonly value: OtlpValue }> };
    readonly scopeSpans?: ReadonlyArray<{ readonly spans?: ReadonlyArray<OtlpSpan> }>;
  }>;
}

function valueOf(value: OtlpValue): string | number | boolean | ReadonlyArray<string> {
  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map((item) => String(valueOf(item)));
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  return value.boolValue ?? false;
}

function msBetween(start: string | number, end: string | number): number {
  return Number((BigInt(end) - BigInt(start)) / BigInt(1_000_000));
}

/** `refuse` answers every export with a 500, as a collector that is up and broken does: the exporter gives up at once. */
export function startOtlpReceiver(options: { readonly refuse?: boolean } = {}): Promise<OtlpReceiver> {
  const spans: ReceivedSpan[] = [];
  let requests = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/traces") {
        res.writeHead(404).end();
        return;
      }
      requests += 1;
      if (options.refuse === true) {
        res.writeHead(500).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OtlpBody;
      for (const resource of body.resourceSpans ?? []) {
        const service = String(valueOf(resource.resource?.attributes?.find((attribute) => attribute.key === "service.name")?.value ?? { stringValue: "" }));
        for (const scope of resource.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            spans.push({
              service,
              name: span.name,
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId ?? "",
              kind: span.kind,
              ms: msBetween(span.startTimeUnixNano, span.endTimeUnixNano),
              attributes: Object.fromEntries((span.attributes ?? []).map((attribute) => [attribute.key, valueOf(attribute.value)])),
              status: { code: span.status?.code ?? 0, message: span.status?.message ?? "" },
            });
          }
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        spans: () => spans,
        requests: () => requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
