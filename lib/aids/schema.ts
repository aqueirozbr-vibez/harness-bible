import { z } from "zod";

import { SectionIdSchema } from "@/lib/schemas/ids";

/*
 * A decision aid as data (feature-specs/18 to come; decided 2026-09-23): the
 * book's derive.py scripts take no arguments, so an aid declares which
 * literals on which lines are its inputs, and the runner applies those edits
 * to a copy of the script before running it. Nothing else in the script
 * changes, so every result is the script's own.
 */

/** Placeholder keys are Python-style; message keys are camelCase like the catalogues. */
const KEY = /^[a-z][a-z0-9_]*$/;
const MESSAGE_KEY = /^[a-z][A-Za-z0-9]*$/;

export const AidInputSchema = z
  .object({
    /** The placeholder name used in `edits[].with` as `{key}`. */
    key: z.string().regex(KEY),
    /** Key under `aids.<aid>.inputs` in the message catalogues. */
    labelKey: z.string().regex(MESSAGE_KEY),
    unit: z.string().nullable(),
    min: z.number(),
    max: z.number(),
    default: z.number(),
    /** The value written into the script is the input multiplied by this (a percentage input feeding a 0–1 literal). */
    scale: z.number().positive().default(1),
    integer: z.boolean().default(false),
  })
  .refine((i) => i.min <= i.default && i.default <= i.max, "default within range")
  .readonly();

export const AidEditSchema = z
  .object({
    /** 1-based line of the lab's script. */
    line: z.number().int().positive(),
    /** Text that must occur exactly once on that line. */
    find: z.string().min(1),
    /** Replacement with `{key}` placeholders for the declared inputs. */
    with: z.string().min(1),
  })
  .readonly();

/**
 * How a step shows what it reads (feature-specs/18 § 3). The arithmetic a step may present is limited to the forms
 * declared here and computed in code (`lib/aids/present.ts`, invariant 12): a bar's width is its value over the
 * step's largest, a ratio headline is `of[0] / of[1]`, and `scale` turns a script's fraction into the percentage the
 * book prints — lab 21 writes `0.769` where chapter 21 says `77%`, lab 37 writes `62.4` where it says `62.4%`, so the
 * data says which it is rather than the code guessing from the size of the number.
 */
const PATH = z.string().min(1);

export const AidBarSchema = z
  .object({
    /** Key under `aids.<aid>.bars`. */
    labelKey: z.string().regex(MESSAGE_KEY),
    path: PATH,
    tone: z.enum(["ink", "ver"]).default("ink"),
    /** 1 for a value shown as it is, 100 for a fraction shown as a percentage. */
    scale: z.union([z.literal(1), z.literal(100)]).default(1),
    /** The unit the value is shown with (`%`, `USD/month`); null for a bare number. */
    unit: z.string().nullable().default(null),
  })
  .readonly();

export const AidHeadlineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), path: PATH, unit: z.string().nullable() }).readonly(),
  /** `13×` is `of[0] / of[1]`, rounded to one decimal in code. */
  z.object({ kind: z.literal("ratio"), of: z.tuple([PATH, PATH]), format: z.literal("times") }).readonly(),
  z.object({ kind: z.literal("pct"), path: PATH, scale: z.union([z.literal(1), z.literal(100)]).default(1) }).readonly(),
]);

export const AidStepSchema = z
  .object({
    ordinal: z.number().int().positive(),
    /** Key under `aids.<aid>.steps`. */
    titleKey: z.string().regex(MESSAGE_KEY),
    /** Slash paths into results/derived.json this step shows (`A/total`, `sensitivity_B/esc/0.3`); keys may contain dots. */
    reads: z.array(PATH).readonly(),
    /** The script line the step's chip points at (`ƒ L24`), null for an inputs step. */
    line: z.number().int().positive().nullable(),
    /** Bars over declared paths; every path must be among `reads` (`checkAid`). */
    bars: z.array(AidBarSchema).readonly().default([]),
    /** One headline per step, or none. */
    headline: AidHeadlineSchema.nullable().default(null),
    /** The section whose source rows price the step, for the verification-date line; null when none. */
    pricesFrom: SectionIdSchema.nullable().default(null),
  })
  .readonly();

export const AidSchema = z
  .object({
    id: z.string().regex(/^\d{2}\.8-[a-z0-9-]+$/, "aid id like 37.8-which-configuration"),
    chapter: z.number().int().min(0).max(40),
    section: SectionIdSchema,
    labId: z.string().regex(/^lab-\d{2}$/),
    script: z.literal("derive.py"),
    /** Key under `aids` in the message catalogues (`ch37WhichConfiguration`). */
    messageKey: z.string().regex(MESSAGE_KEY),
    inputs: z.array(AidInputSchema).min(1).readonly(),
    edits: z.array(AidEditSchema).min(1).readonly(),
    steps: z.array(AidStepSchema).min(2).readonly(),
  })
  .readonly();

export type Aid = z.infer<typeof AidSchema>;
export type AidInput = z.infer<typeof AidInputSchema>;
export type AidStep = z.infer<typeof AidStepSchema>;
export type AidBar = z.infer<typeof AidBarSchema>;
export type AidHeadline = z.infer<typeof AidHeadlineSchema>;
