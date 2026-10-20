import { describe, expect, it } from "vitest";

import { resolveKeyAction, type KeyState } from "./useKeyboardMap";

const idle: KeyState = { pendingG: false };
const free = { inField: false, disabled: false, modifier: false };

describe("resolveKeyAction", () => {
  it("maps the single keys of the map", () => {
    expect(resolveKeyAction("j", idle, free).action).toBe("next");
    expect(resolveKeyAction("k", idle, free).action).toBe("prev");
    expect(resolveKeyAction("[", idle, free).action).toBe("prevChapter");
    expect(resolveKeyAction("]", idle, free).action).toBe("nextChapter");
    expect(resolveKeyAction("a", idle, free).action).toBe("ask");
    expect(resolveKeyAction("r", idle, free).action).toBe("research");
    expect(resolveKeyAction("b", idle, free).action).toBe("bookmark");
    expect(resolveKeyAction("n", idle, free).action).toBe("note");
    expect(resolveKeyAction("/", idle, free).action).toBe("search");
    expect(resolveKeyAction("?", idle, free).action).toBe("help");
    expect(resolveKeyAction("Escape", idle, free).action).toBe("escape");
    expect(resolveKeyAction("x", idle, free).action).toBeNull();
  });

  it("chords g then l into the lab, and drops a stray second key", () => {
    const afterG = resolveKeyAction("g", idle, free);
    expect(afterG.action).toBeNull();
    expect(afterG.state.pendingG).toBe(true);
    expect(resolveKeyAction("l", afterG.state, free)).toEqual({ action: "lab", state: idle });
    expect(resolveKeyAction("j", afterG.state, free)).toEqual({ action: null, state: idle });
    expect(resolveKeyAction("l", idle, free).action).toBeNull();
  });

  it("stays silent in a field, under a modifier, or when turned off, except for escape", () => {
    expect(resolveKeyAction("j", idle, { ...free, inField: true }).action).toBeNull();
    expect(resolveKeyAction("j", idle, { ...free, modifier: true }).action).toBeNull();
    expect(resolveKeyAction("j", idle, { ...free, disabled: true }).action).toBeNull();
    expect(resolveKeyAction("Escape", idle, { ...free, inField: true }).action).toBe("escape");
    expect(resolveKeyAction("l", { pendingG: true }, { ...free, inField: true })).toEqual({ action: null, state: idle });
  });

  it("guards `r` as it guards `a`: never in a field, under a modifier, when turned off, or after `g` (feature-specs/48 § 12, D4)", () => {
    for (const key of ["a", "r"]) {
      expect(resolveKeyAction(key, idle, { ...free, inField: true }).action).toBeNull();
      expect(resolveKeyAction(key, idle, { ...free, modifier: true }).action).toBeNull();
      expect(resolveKeyAction(key, idle, { ...free, disabled: true }).action).toBeNull();
      expect(resolveKeyAction(key, { pendingG: true }, free)).toEqual({ action: null, state: idle });
    }
  });
});
