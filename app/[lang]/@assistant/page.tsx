import { AssistantMount } from "@/components/assistant/AssistantMount";
import { ResearchMount } from "@/components/research/ResearchMount";

/*
 * The `@assistant` slot for `/[lang]` itself (feature-specs/24 § 3.1). The slot is one mount for every page under
 * the locale: this file answers the home page and `[...rest]/page.tsx` every other path. Since unit 77 it holds both
 * docks (feature-specs/48 § 12): the Assistant's, opened by `ask`, and the Research dock, opened by `research`, one at a
 * time; the slot keeps its name.
 */
interface AssistantSlotProps {
  readonly params: Promise<{ lang: string }>;
  readonly searchParams: Promise<Record<string, string | ReadonlyArray<string> | undefined>>;
}

export default async function AssistantSlot({ params, searchParams }: AssistantSlotProps) {
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  return (
    <>
      <AssistantMount lang={lang} path={[]} query={query} />
      <ResearchMount lang={lang} path={[]} query={query} />
    </>
  );
}
