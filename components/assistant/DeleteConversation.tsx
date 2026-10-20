"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBox } from "@/components/ui/ErrorBox";

interface DeleteConversationProps {
  readonly id: string;
  /** The row's label: the chapters its answers cite, never the reader's words (feature-specs/23 D8); null for none. */
  readonly chapters: string | null;
  /** The conversation's own export, offered first; null until it has an answer to export. */
  readonly exportHref: string | null;
  /** An answer of it led to a proposal, which stays under Improve with the name removable (45 § 3.6). */
  readonly ledToProposal: boolean;
  /** An answer streams: the delete waits for its end. */
  readonly streaming: boolean;
  /** Where a deleted conversation leaves the reader: the page without it, `?deleted=<id>` added. */
  readonly doneHref: string;
  /** Told when the dialog opens and closes: the column's overlay keeps its backdrop out of the way meanwhile. */
  readonly onOpenChange?: (open: boolean) => void;
  /** Where the `DELETE` goes: the Assistant conversation's by default, a research's on the Research page (48 § 11.8). */
  readonly endpoint?: string;
  /** Whose words: the Assistant's, or a research's (48 § 19, `research.delete`). */
  readonly namespace?: "assistant.delete" | "research.delete";
}

/**
 * `Delete conversation` (feature-specs/45 § 3.9; unit 62i), in the open conversation's block of the assistant page's
 * column: a quiet button, disabled with its help line while an answer streams, and the shared confirm, whose title
 * names the cited chapters and whose body says what goes and what stays, with the conversation's export offered
 * first. Deleted — or already gone, a 404 — the page is replaced by itself without the conversation and with
 * `?deleted=<id>`, which mounts the dock and the column afresh there, so the URL carries the outcome; and the router
 * is refreshed, so Back asks the server rather than show the conversation from the client's cache (code-standards;
 * review of unit 62). 409: the last answer is still being saved. Anything else keeps the dialog open with what failed
 * and the trace. Cancel and `esc` wait while the request is out.
 *
 * Since unit 73 the Research page's `Delete research` is this button too (feature-specs/48 § 11.5, § 11.8), with the
 * research's endpoint and its words. A research's delete detaches a run under way rather than wait for it, so it is
 * never disabled and never answers 409: `streaming` is false there, and the two lines that only those would show are
 * not in its namespace.
 */
export function DeleteConversation({ id, chapters, exportHref, ledToProposal, streaming, doneHref, onOpenChange, endpoint, namespace = "assistant.delete" }: DeleteConversationProps) {
  const t = useTranslations(namespace);
  const tc = useTranslations("improve.suggest.create");
  const router = useRouter();
  const helpId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly message: string; readonly traceId: string | null } | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    setFailure(null);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(endpoint ?? `/api/v1/assistant/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (response.ok || response.status === 404) {
        router.replace(doneHref);
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: unknown; traceId?: unknown } | null;
      const traceId = typeof body?.traceId === "string" ? body.traceId : null;
      setFailure({ message: response.status === 409 ? t("settling") : typeof body?.message === "string" ? body.message : "", traceId });
    } catch {
      setFailure({ message: t("network"), traceId: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        onClick={() => {
          setOpen(true);
          onOpenChange?.(true);
        }}
        disabled={streaming}
        aria-describedby={streaming ? helpId : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {t("trigger")}
      </Button>
      {streaming ? (
        <span id={helpId} className="help">
          {t("streaming")}
        </span>
      ) : null}
      <ConfirmDialog
        open={open}
        title={chapters === null ? t("titleNone") : t("title", { chapters })}
        body={ledToProposal ? `${t("body")} ${t("bodyProposal")}` : t("body")}
        cancelLabel={t("cancel")}
        confirmLabel={t("confirm")}
        onCancel={close}
        onConfirm={() => void remove()}
        confirmDisabled={busy}
        cancelDisabled={busy}
      >
        {exportHref === null ? null : (
          <a className="xref" href={exportHref} download>
            {t("export")}
          </a>
        )}
        {failure !== null ? (
          <ErrorBox title={t("failed")}>
            {failure.message}
            {failure.traceId !== null ? ` ${tc("trace", { traceId: failure.traceId })}` : null}
          </ErrorBox>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
