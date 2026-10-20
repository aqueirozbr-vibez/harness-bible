import { z } from "zod";

/*
 * Domain unions shared by the UI primitives and, later, the Prisma enums.
 * Values mirror the TRD § 4.2 enums exactly; keep them in sync when the
 * schema unit lands (architecture § 4.2).
 */

/** Source tier of a figure or source row (TRD `SourceTier`). */
export const SourceTierSchema = z.enum([
  "PRIMARY",
  "VENDOR",
  "ANALYST",
  "PRACTITIONER",
  "ILLUSTRATIVE",
  "DERIVED",
  "OPEN",
]);
export type SourceTier = z.infer<typeof SourceTierSchema>;

/** Evidence tier of a suggestion's evidence item (TRD `EvidenceTier`). */
export const EvidenceTierSchema = z.enum(["A", "B", "C", "D", "E", "F", "G", "U"]);
export type EvidenceTier = z.infer<typeof EvidenceTierSchema>;

/**
 * Visual tone of a status mark (ui-context § 6). The nine product states map
 * onto five tones: ok (verified, redteam passed, reproduced), fail (not
 * reproduced, killed, declined), warn (stale, request more), mute (unverified,
 * no lab), run (running).
 */
export const StatusToneSchema = z.enum(["ok", "fail", "warn", "mute", "run"]);
export type StatusTone = z.infer<typeof StatusToneSchema>;

/** Edition language of content rows (TRD `Lang`). Route locales are lowercase; see `lib/i18n/routing.ts`. */
export const LangSchema = z.enum(["EN", "PT"]);
export type Lang = z.infer<typeof LangSchema>;

/** VERIFY and REDTEAM status of a chapter version (TRD `VerifyStatus`). */
export const VerifyStatusSchema = z.enum(["PASSED", "FAILED", "UNVERIFIED"]);
export type VerifyStatus = z.infer<typeof VerifyStatusSchema>;

/** The nine layers of a chapter, in order (TRD `Layer`); ordinal = index + 1. */
export const LayerSchema = z.enum([
  "INTUITION",
  "MECHANISM",
  "WORKED_NUMBERS",
  "MEASUREMENT",
  "FAILURE",
  "FRONTIER",
  "INDUSTRIAL_APPLICATION",
  "DECISION_AIDS",
  "SOURCES",
]);
export type Layer = z.infer<typeof LayerSchema>;
export const LAYER_ORDER: ReadonlyArray<Layer> = LayerSchema.options;

/** Result of one row in a lab diff (TRD `DiffStatus`). */
export const DiffStatusSchema = z.enum(["MATCH", "DIVERGE", "NEW"]);
export type DiffStatus = z.infer<typeof DiffStatusSchema>;
