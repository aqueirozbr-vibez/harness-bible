import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

interface RenderCheckProps {
  readonly releaseId: string;
  /** Whether the rendered content hash matched the release's (invariant 2). */
  readonly ok: boolean;
}

/** Render check line at the foot of the rail (spec § 6.9). */
export function RenderCheck({ releaseId, ok }: RenderCheckProps) {
  const t = useTranslations("reader.render");
  return (
    <div className="rt col" style={{ paddingTop: 12, gap: 4 }}>
      <span className="cap">{t("cap")}</span>
      <span className={cn("meta", !ok && "text-fail")}>{ok ? t("ok", { id: releaseId }) : t("bad", { id: releaseId })}</span>
    </div>
  );
}
