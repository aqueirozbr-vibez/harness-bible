"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { FlagKind } from "@/lib/assistant/turns";

/*
 * The reader's one word back (feature-specs/17 § 4): a coded reason that enters the grader's calibration set with
 * the answer's verdicts. No free text anywhere — a flag is a label, not a message — and one flag per reader per
 * message, so a flagged button stays flagged and says with what.
 *
 * The reasons an answer takes are not the reasons a refusal takes: `should have refused` only makes sense of an
 * answer, `should not have refused` only of a refusal. The endpoint refuses a label that contradicts the row (15 § 5.4);
 * the dialog simply never offers one.
 *
 * Since unit 73 a research run's report and refusal are flagged with it too (feature-specs/48 § 11.5, § 11.7): the
 * caller gives the endpoint to post to and how a 409 reads the flag that stands back, and the namespace whose words
 * the button and the dialog say — research has no grader, so its dialog says the flag is a label for the operator.
 * A report takes the answer's reasons (A9, "as answers"). The Assistant's own endpoint, read-back and words stay the
 * default.
 */

const REASONS: Readonly<Record<FlagKind | "report", ReadonlyArray<string>>> = {
  answer: ["wrong_citation", "missing_citation", "wrong_number", "should_refuse", "other"],
  report: ["wrong_citation", "missing_citation", "wrong_number", "should_refuse", "other"],
  refusal: ["should_not_refuse", "other"],
};

/** What is flagged: an Assistant message, through the Assistant's endpoint, or anything else through the caller's own. */
type FlagTarget =
  | {
      readonly messageId: string;
      /** The conversation the message belongs to: a 409 reads the stored reason back from it. */
      readonly conversationId: string;
      readonly endpoint?: undefined;
      readonly readBack?: undefined;
    }
  | {
      readonly messageId?: undefined;
      readonly conversationId?: undefined;
      /** Where the flag is posted (a research run's, 48 § 13). */
      readonly endpoint: string;
      /** The flag that stands, read again after a 409 (48 § 18); null where it cannot be read. */
      readonly readBack: () => Promise<string | null>;
    };

type FlagButtonProps = FlagTarget & {
  readonly kind: FlagKind | "report";
  /** The flag already on the row, from the `GET`; the button then only says so. */
  readonly flagged: { readonly reason: string } | null;
  /** The refusal card's footer takes the quiet form (§ 3). */
  readonly quiet?: boolean;
  /** The walk's footer (feature-specs/18 § 5.2): `Flag this step`, and a dialog title that names the step. One flag per message still. */
  readonly label?: string;
  readonly title?: string;
  /** Whose words: the Assistant's, or a research's (48 § 19, `research.flag`). */
  readonly namespace?: "assistant.flag" | "research.flag";
};

/** The Assistant's own read-back: the message's flag in its conversation's view. */
async function messageFlagOf(conversationId: string, messageId: string): Promise<string | null> {
  return fetch(`/api/v1/assistant/conversations/${conversationId}`)
    .then((view) => (view.ok ? view.json() : null))
    .then((view: { messages?: Array<{ id: string; flag: { reason: string } | null }> } | null) => view?.messages?.find((message) => message.id === messageId)?.flag?.reason ?? null)
    .catch(() => null);
}

export function FlagButton({ kind, flagged, quiet = false, label, title, namespace = "assistant.flag", ...target }: FlagButtonProps) {
  const t = useTranslations(namespace);
  const tr = useTranslations("assistant.refusal");
  const [reason, setReason] = useState<string | null>(flagged?.reason ?? null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(REASONS[kind][0] ?? "other");
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selectId = useId();
  const endpoint = target.endpoint === undefined ? `/api/v1/assistant/messages/${target.messageId}/flag` : target.endpoint;

  const submit = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, reason: choice }),
      });
      if (response.ok) {
        setReason(choice);
        setOpen(false);
        return;
      }
      /* Already flagged, by this reader on another tab or an earlier visit: the row's reason is the truth. */
      if (response.status === 409) {
        const stored = target.endpoint === undefined ? await messageFlagOf(target.conversationId, target.messageId) : await target.readBack();
        setReason(stored ?? choice);
        setOpen(false);
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
      setFailure(typeof body?.message === "string" ? body.message : "");
    } finally {
      setPending(false);
    }
  };

  if (reason !== null) {
    return (
      <Button size="sm" variant={quiet ? "quiet" : "default"} disabled className="flag-flagged cap">
        {t("flagged", { reason: t(`reasons.${reason}`) })}
      </Button>
    );
  }

  /* the Assistant's catalogue words a refusal's button in the card's own namespace; research's has its own (48 § 19) */
  const named = label ?? (kind === "refusal" && namespace === "assistant.flag" ? tr("flag") : t(kind));

  return (
    <>
      <Button
        size="sm"
        variant={quiet ? "quiet" : "default"}
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        {named}
      </Button>
      <ConfirmDialog
        open={open}
        title={title ?? t(`title.${kind}`)}
        body={t("body")}
        cancelLabel={t("cancel")}
        confirmLabel={t("confirm")}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          void submit();
        }}
        confirmDisabled={pending}
      >
        <div className="field">
          <label htmlFor={selectId}>{t("reason")}</label>
          <select id={selectId} className="select" value={choice} onChange={(event) => setChoice(event.target.value)}>
            {REASONS[kind].map((value) => (
              <option key={value} value={value}>
                {t(`reasons.${value}`)}
              </option>
            ))}
          </select>
          {failure === null ? null : <p className="help err">{failure}</p>}
        </div>
      </ConfirmDialog>
    </>
  );
}
