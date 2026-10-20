import { AssistantMount } from "@/components/assistant/AssistantMount";
import { ResearchMount } from "@/components/research/ResearchMount";

/*
 * The `@assistant` slot for every path under the locale but the home page (feature-specs/24 § 3.1): the catch-all
 * slot of the Next docs (parallel-routes.md), so one mount serves the reader, the search page, the paths, the marks
 * and the account alike. Tried on each of them by hard load and client navigation before it was built on (41a). Since
 * unit 77 it holds both docks (feature-specs/48 § 12): the Assistant's, opened by `ask`, and the Research dock, opened
 * by `research`, one at a time; the slot keeps its name.
 */
interface AssistantSlotProps {
  readonly params: Promise<{ lang: string; rest: ReadonlyArray<string> }>;
  readonly searchParams: Promise<Record<string, string | ReadonlyArray<string> | undefined>>;
}

export default async function AssistantSlot({ params, searchParams }: AssistantSlotProps) {
  const [{ lang, rest }, query] = await Promise.all([params, searchParams]);
  return (
    <>
      <AssistantMount lang={lang} path={rest} query={query} />
      <ResearchMount lang={lang} path={rest} query={query} />
    </>
  );
}
