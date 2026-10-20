import { useTranslations } from "next-intl";

import { InstrumentPanel } from "@/components/chrome/InstrumentPanel";
import { Button } from "@/components/ui/Button";
import { StatusMark } from "@/components/ui/StatusMark";
import { formatDayMonthTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/routing";
import type { AccountData } from "@/lib/schemas/auth";

import { revokeOneSession, revokeOthers } from "@/app/[lang]/account/actions";

interface SessionsInstrumentProps {
  readonly data: AccountData;
  readonly locale: Locale;
}

const DEVICE_KEYS: ReadonlySet<string> = new Set(["edgeWindows", "chromeWindows", "firefoxWindows", "safariMac", "chromeMac", "safariIphone", "safariIpad", "chromeAndroid", "unknown"]);

/** Open sessions with a `Sign out` per row and `Sign out everywhere` (feature-specs/08 § 6.3). */
export function SessionsInstrument({ data, locale }: SessionsInstrumentProps) {
  const t = useTranslations("account");
  const { sessions, olderSessions } = data;
  const deviceLabel = (key: string) => t(`device.${DEVICE_KEYS.has(key) ? key : "unknown"}`);
  return (
    <section id="sessions" className="col" style={{ scrollMarginTop: 16 }}>
      <InstrumentPanel
        label={t("sessions.label")}
        meta={[{ key: "n", node: t("sessions.open", { n: sessions.length + olderSessions }) }]}
        body="bare"
        className="account-inst"
        footer={
          <form action={revokeOthers} className="between" style={{ width: "100%" }}>
            <input type="hidden" name="locale" value={locale} />
            <span className="meta">{olderSessions > 0 ? t("sessions.older", { k: olderSessions }) : ""}</span>
            <Button type="submit" variant="quiet" size="sm" disabled={sessions.length + olderSessions <= 1}>
              {t("sessions.everywhere")}
            </Button>
          </form>
        }
      >
        <div className="sessions-table-wrap">
        <table className="tbl small sessions-table">
          <thead>
            <tr>
              <th>{t("sessions.device")}</th>
              <th>{t("sessions.signedIn")}</th>
              <th>{t("sessions.lastSeen")}</th>
              <th className="desktop-only">{t("sessions.expires")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  {deviceLabel(s.device)}
                  {s.current ? (
                    <>
                      {" "}
                      <StatusMark tone="ok">{t("sessions.current")}</StatusMark>
                    </>
                  ) : null}
                </td>
                <td className="m">{formatDayMonthTime(s.createdAt, locale)}</td>
                <td className="m">{formatDayMonthTime(s.lastSeenAt, locale)}</td>
                <td className="m desktop-only">{formatDayMonthTime(s.expiresAt, locale)}</td>
                <td>
                  <form action={revokeOneSession}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="sessionId" value={s.id} />
                    <Button type="submit" variant="quiet" size="sm">
                      {t("sessions.signOut")}
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </InstrumentPanel>
    </section>
  );
}
