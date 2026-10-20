import { useTranslations } from "next-intl";

interface ChangeTableProps {
  /** The anchored text as it stands, where the change replaces something; null for a claim or a row added. */
  readonly before: string | null;
  readonly after: string | null;
  readonly contentLang: "en" | "pt";
}

/**
 * A change before and after (feature-specs/35 § 4; 43 § 5.1): the outcome page's two rows, `before · current` and
 * `after · proposed`, the second marked new. The edit page's fixed proposal and the proposal panel under an answer
 * draw the same table; nothing renders where there is no after.
 */
export function ChangeTable({ before, after, contentLang }: ChangeTableProps) {
  const ta = useTranslations("improve.outcome.anchor");
  if (after === null) return null;
  return (
    <table className="tbl outcome-change">
      <tbody>
        {before !== null ? (
          <tr>
            <th scope="row" className="meta">
              {ta("before")}
            </th>
            <td lang={contentLang}>{before}</td>
          </tr>
        ) : null}
        <tr className="row-new">
          <th scope="row" className="meta">
            {ta("after")}
          </th>
          <td className="d-new" lang={contentLang}>
            {after}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
