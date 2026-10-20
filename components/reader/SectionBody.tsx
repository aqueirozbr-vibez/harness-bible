import { ProseInteractions } from "@/components/reader/ProseInteractions";
import type { ChapterData } from "@/lib/schemas/chapter";
import type { Lang } from "@/lib/schemas/domain";

interface SectionBodyProps {
  readonly section: ChapterData["section"];
  /** Edition language of the body actually rendered. */
  readonly lang: Lang;
  readonly pending: boolean;
}

const HTML_LANG_OF: Record<Lang, string> = { EN: "en-GB", PT: "pt-BR" };

/**
 * The section's pre-rendered body. The one permitted use of dangerouslySetInnerHTML
 * (code-standards § React): the HTML comes from the release rows and was
 * validated against the § 4.2 vocabulary by the loader's schema.
 */
export function SectionBody({ section, lang, pending }: SectionBodyProps) {
  return (
    <ProseInteractions codeBlocks={section.codeBlocks}>
      <div
        className="prose"
        lang={pending ? HTML_LANG_OF[lang] : undefined}
        dangerouslySetInnerHTML={{ __html: section.bodyHtml }}
      />
    </ProseInteractions>
  );
}
