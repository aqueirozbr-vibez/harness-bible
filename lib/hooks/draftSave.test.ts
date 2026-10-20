import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Proposal } from "@/lib/schemas/improve";

import { AUTOSAVE_PAUSE_MS, createDraftAutosave, type DraftSaveDetail } from "./draftSave";

const AT = new Date("2026-10-08T14:02:31Z");
const VIEW = { changeClass: "CITED_FIGURE", curatorReason: null, thresholds: { acceptAt: 70, floorAt: 25 }, fastMoving: true };
const value = (after: string): Proposal => ({ kind: "SET_VALUE", after, unit: "tokens" });

function harness(saved: Proposal | null = null, answer: () => Promise<Response> = () => Promise.resolve(Response.json(VIEW))) {
  const sends: Array<{ readonly proposal: unknown; readonly keepalive: boolean }> = [];
  const events: DraftSaveDetail[] = [];
  const autosave = createDraftAutosave(saved, {
    send: (body, keepalive) => {
      sends.push({ proposal: (JSON.parse(body) as { proposal: unknown }).proposal, keepalive });
      return answer();
    },
    dispatch: (detail) => events.push(detail),
    now: () => AT,
  });
  return { autosave, sends, events, states: () => events.map((event) => event.state) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDraftAutosave: the suggest form's saves (34 § 5, D3)", () => {
  it("saves one pause after the last edit, once, with the latest proposal", async () => {
    const { autosave, sends, events, states } = harness();
    autosave.change(value("8000"), null);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS / 2);
    autosave.change(value("8500"), null);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS - 1);
    expect(sends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends).toEqual([{ proposal: value("8500"), keepalive: false }]);
    expect(states()).toEqual(["dirty", "dirty", "saving", "saved"]);
    expect(events.at(-1)).toEqual({ state: "saved", at: AT.toISOString(), draftClass: VIEW });
  });

  it("saves at once when a field loses focus, and not again at the pause", async () => {
    const { autosave, sends } = harness();
    autosave.change(value("8000"), null);
    autosave.flush();
    expect(sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS * 2);
    autosave.flush();
    expect(sends).toHaveLength(1);
  });

  it("sends nothing the server already has", async () => {
    const { autosave, sends, states } = harness(value("7500"));
    autosave.change(value("7500"), null);
    autosave.flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS * 2);
    expect(sends).toEqual([]);
    expect(states()).toEqual(["clean", "clean"]);
  });

  it("sends nothing for fields that make no proposal, says why after the pause, and drops the save that was waiting", async () => {
    const { autosave, sends, events } = harness();
    autosave.change(value("8000"), null);
    autosave.change(null, "a decimal like 0.25");
    /* `0.` on the way to `0.25` is not refused at the keystroke. */
    expect(events).toEqual([{ state: "dirty" }, { state: "dirty" }]);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS);
    expect(events.at(-1)).toEqual({ state: "invalid", message: "a decimal like 0.25" });
    autosave.flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS * 2);
    expect(sends).toEqual([]);
    expect(events.at(-1)).toEqual({ state: "invalid", message: "a decimal like 0.25" });
  });

  it("holds a change made while a save is out, and saves it when the first returns", async () => {
    let release: (response: Response) => void = () => undefined;
    let first = true;
    const { autosave, sends, states } = harness(null, () => {
      if (!first) return Promise.resolve(Response.json(VIEW));
      first = false;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    autosave.change(value("8000"), null);
    autosave.flush();
    autosave.change(value("9000"), null);
    autosave.flush();
    expect(sends).toHaveLength(1);
    release(Response.json(VIEW));
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((send) => send.proposal)).toEqual([value("8000"), value("9000")]);
    /* No `saved` for 8000: the fields already said 9000, which is what a wait on every field's save waits for (34 § 26). */
    expect(states()).toEqual(["dirty", "saving", "dirty", "saving", "saved"]);
  });

  it("says no `saved` for a body the fields have moved past, so Submit's wait for every field ends on the newer save", async () => {
    let release: (response: Response) => void = () => undefined;
    let first = true;
    const { autosave, sends, events } = harness(null, () => {
      if (!first) return new Promise<Response>(() => undefined);
      first = false;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    autosave.change(value("8000"), null);
    autosave.flush();
    /* Typed while 8000 is out, then Submit asks every field to save at once. */
    autosave.change(value("9000"), null);
    autosave.flush();
    release(Response.json(VIEW));
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((send) => send.proposal)).toEqual([value("8000"), value("9000")]);
    expect(events.some((event) => event.state === "saved")).toBe(false);
    expect(events.at(-1)?.state).toBe("saving");
  });

  it("keeps saying a newer change is unsaved when an older save returns before the change's pause is out", async () => {
    let release: (response: Response) => void = () => undefined;
    let first = true;
    const { autosave, sends, events, states } = harness(null, () => {
      if (!first) return Promise.resolve(Response.json(VIEW));
      first = false;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    autosave.change(value("8000"), null);
    autosave.flush();
    autosave.change(value("9000"), null);
    release(Response.json(VIEW));
    await vi.advanceTimersByTimeAsync(0);
    expect(states()).toEqual(["dirty", "saving", "dirty", "dirty"]);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS);
    expect(sends.map((send) => send.proposal)).toEqual([value("8000"), value("9000")]);
    expect(events.at(-1)?.state).toBe("saved");
  });

  it("keeps the fields' reason when an older save returns after they stopped making a proposal", async () => {
    let release: (response: Response) => void = () => undefined;
    const { autosave, events } = harness(null, () => new Promise<Response>((resolve) => (release = resolve)));
    autosave.change(value("8000"), null);
    autosave.flush();
    autosave.change(null, "a decimal like 0.25");
    release(Response.json(VIEW));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.slice(-2)).toEqual([{ state: "saved", at: AT.toISOString(), draftClass: VIEW }, { state: "invalid", message: "a decimal like 0.25" }]);
  });

  it("sends a change back to the saved value made while a save is out, once that save returns", async () => {
    let release: (response: Response) => void = () => undefined;
    let first = true;
    const { autosave, sends, states } = harness(value("7500"), () => {
      if (!first) return Promise.resolve(Response.json(VIEW));
      first = false;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    autosave.change(value("75000"), null);
    autosave.flush();
    /* Ctrl+Z while 75000 is out: the server will hold 75000, so 7500 is a change. */
    autosave.change(value("7500"), null);
    release(Response.json(VIEW));
    await vi.advanceTimersByTimeAsync(0);
    expect(states()).toEqual(["dirty", "saving", "dirty", "dirty"]);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS);
    expect(sends.map((send) => send.proposal)).toEqual([value("75000"), value("7500")]);
  });

  it("does not try a refused save again by itself", async () => {
    const { autosave, sends, states } = harness(null, () => Promise.resolve(Response.json({ code: "CONFLICT", message: "suggestion S-21-0001 is SUBMITTED", traceId: "4bf92f35" }, { status: 409 })));
    autosave.change(value("8000"), null);
    autosave.flush();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS * 5);
    expect(sends).toHaveLength(1);
    expect(states()).toEqual(["dirty", "saving", "failed"]);
  });

  it("says the server's reason and trace when it refuses, and tries again at the next blur", async () => {
    let status = 409;
    const { autosave, sends, events } = harness(null, () => Promise.resolve(Response.json(status === 200 ? VIEW : { code: "CONFLICT", message: "suggestion S-21-0001 is SUBMITTED", traceId: "4bf92f35" }, { status })));
    autosave.change(value("8000"), null);
    autosave.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toEqual({ state: "failed", reached: true, message: "suggestion S-21-0001 is SUBMITTED", traceId: "4bf92f35" });
    status = 200;
    autosave.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(2);
    expect(events.at(-1)?.state).toBe("saved");
  });

  it("says when the request did not reach the server", async () => {
    const { autosave, events } = harness(null, () => Promise.reject(new TypeError("fetch failed")));
    autosave.change(value("8000"), null);
    autosave.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toEqual({ state: "failed", reached: false, message: null, traceId: null });
  });

  it("sends on leaving what differs from the request still out, and nothing when the fields are that request", async () => {
    const sendsOf = (calls: ReadonlyArray<{ readonly proposal: unknown; readonly keepalive: boolean }>) => calls.map((call) => [call.proposal, call.keepalive]);
    const { autosave, sends } = harness(null, () => new Promise<Response>(() => undefined));
    autosave.change(value("8000"), null);
    autosave.flush();
    autosave.leave();
    expect(sendsOf(sends)).toEqual([[value("8000"), false]]);
    autosave.change(value("9000"), null);
    autosave.leave();
    expect(sendsOf(sends)).toEqual([
      [value("8000"), false],
      [value("9000"), true],
    ]);
  });

  it("sends what is unsaved with keepalive when the page goes away, and nothing when all is saved", async () => {
    const { autosave, sends } = harness();
    autosave.leave();
    expect(sends).toEqual([]);
    autosave.change(value("8000"), null);
    autosave.leave();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS * 2);
    expect(sends).toEqual([{ proposal: value("8000"), keepalive: true }]);
  });
});

describe("a deleted draft's autosave (feature-specs/45 § 4; unit 63g)", () => {
  it("sends nothing once halted: not at the pause, not on a blur, not on leaving, and a request still out says nothing when it answers", async () => {
    let answer: (response: Response) => void = () => undefined;
    const { autosave, sends, states } = harness(null, () => new Promise<Response>((resolve) => {
      answer = resolve;
    }));
    autosave.change(value("8000"), null);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS);
    expect(sends).toHaveLength(1);
    const said = states().length;
    autosave.change(value("8500"), null);
    autosave.halt();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS * 2);
    autosave.flush();
    autosave.leave();
    autosave.change(value("9000"), null);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS * 2);
    expect(sends).toHaveLength(1);
    /* the request that was out answers: the draft is gone, so nothing is said of it */
    answer(Response.json(VIEW));
    await vi.advanceTimersByTimeAsync(0);
    expect(states().slice(said)).toEqual(["dirty"]);
    expect(sends).toHaveLength(1);
  });
});

describe("the rationale's autosave: the same machine, its own field (unit 51e)", () => {
  it("saves the rationale as its own field, a second after the last keystroke, and hands each answer on as the draft's view", async () => {
    const bodies: string[] = [];
    const views: unknown[] = [];
    const autosave = createDraftAutosave(
      "Three.",
      {
        send: (body) => {
          bodies.push(body);
          return Promise.resolve(Response.json(VIEW));
        },
        dispatch: () => undefined,
        now: () => AT,
        view: (payload) => views.push(payload),
      },
      "rationale",
    );
    autosave.change("Three.", null);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS);
    expect(bodies).toEqual([]);
    autosave.change("Four, as the lab shows.", null);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_PAUSE_MS);
    expect(bodies).toEqual([JSON.stringify({ rationale: "Four, as the lab shows." })]);
    expect(views).toEqual([VIEW]);
  });
});
