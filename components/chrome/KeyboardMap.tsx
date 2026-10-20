"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { useKeyboardMap, type KeyTargets } from "@/lib/hooks/useKeyboardMap";

interface KeyboardMapProps {
  readonly targets: KeyTargets;
  /** Lists the `b` and `n` rows, which act only on a signed-in reader's marks (feature-specs/07 § 9). */
  readonly signedIn?: boolean;
}

/** Mounts the global shortcuts and renders the `?` map as a floating instrument (ui-context § 12). */
export function KeyboardMap({ targets, signedIn = false }: KeyboardMapProps) {
  const t = useTranslations("reader.keys");
  const { helpOpen, closeHelp } = useKeyboardMap(targets);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (helpOpen) dialogRef.current?.focus();
  }, [helpOpen]);

  if (!helpOpen) return null;

  const rows: ReadonlyArray<{ keys: ReadonlyArray<string>; label: string }> = [
    { keys: ["/"], label: t("search") },
    { keys: ["j", "k"], label: t("section") },
    { keys: ["[", "]"], label: t("chapter") },
    { keys: ["g", "l"], label: t("lab") },
    { keys: ["a"], label: t("ask") },
    /* the Research dock's key, after the Assistant's (feature-specs/48 § 12, D4) */
    { keys: ["r"], label: t("research") },
    ...(signedIn ? [{ keys: ["b"], label: t("bookmark") }, { keys: ["n"], label: t("note") }] : []),
    { keys: ["esc"], label: t("escape") },
    { keys: ["?"], label: t("help") },
  ];

  return (
    <div ref={dialogRef} className="peek peek-help col" role="dialog" aria-label={t("mapLabel")} tabIndex={-1}>
      <div className="inst-h">
        <span className="t">{t("mapTitle")}</span>
        <span className="ts">
          <IconButton label={t("close")} onClick={closeHelp}>
            ×
          </IconButton>
        </span>
      </div>
      <table className="tbl small">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="m keymap-keys">
                {row.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </td>
              <td>{row.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="inst-f">{t("offNote")}</div>
    </div>
  );
}
