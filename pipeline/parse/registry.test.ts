import { describe, expect, it } from "vitest";

import { fixture } from "./fixtures";
import { headingDate, openFindings, registryStatus } from "./registry";

describe("registry", () => {
  it("reads chapter 21's verify and redteam files", () => {
    const status = registryStatus(fixture("ch21-verify.md"), fixture("ch21-redteam.md"));
    expect(status.verifyStatus).toBe("PASSED");
    expect(status.verifiedAt?.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(status.redteamStatus).toBe("PASSED");
    expect(status.redteamOpen).toBe(0);
  });

  it("is unverified without files", () => {
    expect(registryStatus(null, null)).toEqual({ verifyStatus: "UNVERIFIED", verifiedAt: null, redteamStatus: "UNVERIFIED", redteamOpen: 0 });
  });

  it("counts OPEN rows only in a status table (D5)", () => {
    const text = "# REDTEAM — x (3 Sep 2026)\n\n| Finding | Severity | Status |\n|---|---|---|\n| a | MAJOR | OPEN |\n| b | MINOR | closed |\n| c | MAJOR | open |\n\n| Layer | Score |\n|---|---|\n| 1 | OPEN |\n";
    expect(openFindings(text)).toBe(2);
    expect(headingDate(text)?.toISOString()).toBe("2026-09-03T00:00:00.000Z");
    expect(headingDate("# no date here")).toBeNull();
  });
});
