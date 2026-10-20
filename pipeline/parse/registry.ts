/*
 * registry/chNN-verify.md and chNN-redteam.md → verification status and dates
 * (feature-specs/04 § 6.9). Presence is the signal; the heading carries the date.
 */

export interface RegistryStatus {
  readonly verifyStatus: "PASSED" | "UNVERIFIED";
  readonly verifiedAt: Date | null;
  readonly redteamStatus: "PASSED" | "UNVERIFIED";
  readonly redteamOpen: number;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** `(21 Sep 2026, batch pass)` in the first heading → 2026-09-21 UTC. */
export function headingDate(text: string): Date | null {
  const heading = text.split(/\r?\n/).find((l) => l.startsWith("#")) ?? "";
  const m = /\((\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/.exec(heading);
  if (m === null) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), month - 1, Number(m[1])));
}

/** Rows marked OPEN in a table whose header names a Status column (D5). */
export function openFindings(text: string): number {
  const lines = text.split(/\r?\n/);
  let inStatusTable = false;
  let count = 0;
  for (const line of lines) {
    if (/^\|.*\bstatus\b.*\|$/i.test(line)) {
      inStatusTable = true;
      continue;
    }
    if (!line.startsWith("|")) {
      inStatusTable = false;
      continue;
    }
    if (inStatusTable && /\|\s*open\s*\|/i.test(line)) count += 1;
  }
  return count;
}

export function registryStatus(verifyText: string | null, redteamText: string | null): RegistryStatus {
  return {
    verifyStatus: verifyText === null ? "UNVERIFIED" : "PASSED",
    verifiedAt: verifyText === null ? null : headingDate(verifyText),
    redteamStatus: redteamText === null ? "UNVERIFIED" : "PASSED",
    redteamOpen: redteamText === null ? 0 : openFindings(redteamText),
  };
}
