/*
 * Next.js calls `register` once when a server process starts (feature-specs/21 § 5.1). The web tier starts its
 * tracer here, and only when a collector is configured (D3): unset, `startTelemetry` returns before it loads any
 * OpenTelemetry code.
 *
 * `NEXT_RUNTIME` is the framework's own constant, not configuration of this product, which is why it is read here
 * and not through `lib/env.ts` (code-standards § Configuration names the exception): Next compiles this file for
 * the edge runtime as well, and the comparison is what lets it leave the tracer, which needs Node, out of that
 * bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTelemetry } = await import("@/lib/telemetry/tracer");
  if (await startTelemetry("hb-web")) console.info("telemetry: the web tier exports its spans");
}
