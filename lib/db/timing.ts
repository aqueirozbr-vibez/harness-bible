/**
 * Measure a loader call for the status bar's `loaded 0.38 s` cell
 * (feature-specs/02-book-home.md § 6.8). Lives beside the loaders rather than
 * in a component: a Server Component body must stay pure, and this is a
 * per-request server measurement, not render state.
 */
export async function timed<T>(load: () => Promise<T>): Promise<{ readonly result: T; readonly ms: number }> {
  const started = performance.now();
  const result = await load();
  return { result, ms: performance.now() - started };
}
