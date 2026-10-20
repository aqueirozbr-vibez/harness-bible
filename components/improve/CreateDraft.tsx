"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ErrorBox } from "@/components/ui/ErrorBox";
import type { Locale } from "@/lib/i18n/routing";
import type { AnchorKind, ChangeKind } from "@/lib/schemas/improve";

interface CreateDraftProps {
  readonly locale: Locale;
  readonly anchor: { readonly kind: AnchorKind; readonly id: string };
  /** What can be proposed on this anchor: a section's four, or a figure's or a row's one (lib/improve/suggest.ts). */
  readonly changeKinds: ReadonlyArray<ChangeKind>;
}

interface Refusal {
  readonly message: string;
  readonly traceId: string | null;
}

/**
 * The step's button (feature-specs/34 § 4; unit 51b, part 2): for a section, what is proposed (34 D4), since the
 * draft's kind is final; then the draft, created through `POST /api/v1/suggestions` as the dock posts its turns, so
 * that the handler's limit, idempotency, policy and throttle all apply. The key is kept for one body: a second click
 * replays the first draft, and a changed choice is a new request. On success the page is the draft's edit page.
 */
export function CreateDraft({ locale, anchor, changeKinds }: CreateDraftProps) {
  const t = useTranslations("improve.suggest.create");
  const ts = useTranslations("improve.suggest");
  const router = useRouter();
  const [changeKind, setChangeKind] = useState<ChangeKind | undefined>(changeKinds[0]);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const attempt = useRef<{ readonly body: string; readonly key: string } | null>(null);

  const create = async (): Promise<void> => {
    if (changeKind === undefined || pending) return;
    const body = JSON.stringify({ anchor, changeKind, locale });
    const key = attempt.current !== null && attempt.current.body === body ? attempt.current.key : crypto.randomUUID();
    attempt.current = { body, key };
    setPending(true);
    setRefusal(null);
    try {
      const response = await fetch("/api/v1/suggestions", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body });
      const payload = (await response.json().catch(() => null)) as { id?: unknown; message?: unknown; traceId?: unknown } | null;
      if (response.ok && typeof payload?.id === "string") {
        router.push(`/${locale}/improve/${payload.id}/edit`);
        return;
      }
      setRefusal({ message: typeof payload?.message === "string" ? payload.message : t("unknown"), traceId: typeof payload?.traceId === "string" ? payload.traceId : null });
    } catch {
      setRefusal({ message: t("network"), traceId: null });
    }
    setPending(false);
  };

  return (
    <div className="col anchor-create">
      {changeKinds.length > 1 ? (
        <fieldset className="col anchor-change">
          <legend className="flabel">{t("changeLabel")}</legend>
          {changeKinds.map((kind) => (
            <label key={kind} className="check">
              <input type="radio" name="changeKind" value={kind} checked={changeKind === kind} onChange={() => setChangeKind(kind)} disabled={pending} />
              {t(`change.${kind}`)}
            </label>
          ))}
          <p className="help">{ts("sectionNext")}</p>
        </fieldset>
      ) : null}
      <button type="button" className="btn btn-p" onClick={() => void create()} disabled={pending || changeKind === undefined} aria-busy={pending}>
        {t("button")}
      </button>
      {refusal !== null ? (
        <ErrorBox title={t("failed")}>
          {refusal.message}
          {refusal.traceId !== null ? ` ${t("trace", { traceId: refusal.traceId })}` : null}
        </ErrorBox>
      ) : null}
    </div>
  );
}
