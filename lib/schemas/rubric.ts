import { z } from "zod";

import { EvidenceTierSchema, SourceTierSchema } from "@/lib/schemas/domain";
import { SectionIdSchema, SuggestionIdSchema } from "@/lib/schemas/ids";
import { ChangeClassSchema, ChangeKindSchema, DecisionSchema } from "@/lib/schemas/improve";

/*
 * The rubric as data (feature-specs/30 § 3, § 4.3, § 5.1). `RubricRulesSchema` is what the score's arithmetic
 * reads: every number of a score comes from here and none is typed into lib/rubric, so that a rubric change is a
 * new file and not a change of code. `RubricSchema` is the published file: the rules and, around them, the version,
 * its dates, the book's chips mapped to evidence tiers, the four worked examples with every number of their
 * arithmetic, and the changelog. The file holds numbers, enumerations, ids and days, and no sentence: the page's
 * words are the catalogue's (§ 6).
 *
 * Pure: zod and constants.
 */

/** A rubric's version, as its folder and its row are named: `v1.2`. */
export const RubricVersionSchema = z.string().regex(/^v\d+\.\d+$/, "a version like v1.2");
export type RubricVersion = z.infer<typeof RubricVersionSchema>;

/** Where a scored suggestion goes (§ 4.4); `lib/rubric/thresholds.ts` decides it. */
export const ROUTES = ["DECLINE_AT_INTAKE", "REQUEST_MORE_BY_RULE", "CURATOR", "ADJUDICATE"] as const;
export const RouteSchema = z.enum(ROUTES);
export type Route = z.infer<typeof RouteSchema>;

/** How directly an item bears on the anchored claim: the evidence grader's classification (feature-specs/32 § 7.2). */
export const RELEVANCES = ["direct", "partial", "tangential"] as const;
export const RelevanceSchema = z.enum(RELEVANCES);
export type Relevance = z.infer<typeof RelevanceSchema>;

/** Whose the source is: nobody's with a stake, the vendor the claim is about, or the contributor's own employer (32 § 7.4). */
export const STAKES = ["none", "vendor", "employer"] as const;
export const StakeSchema = z.enum(STAKES);
export type Stake = z.infer<typeof StakeSchema>;

/** A multiplier: never above one, and in hundredths, so that a score is computed in whole numbers (30 § 3.2, D1). */
export const RubricFactorSchema = z.number().min(0).max(1).multipleOf(0.01);

const PointsSchema = z.number().int().min(0).max(100);

export const RubricTierSchema = z.strictObject({
  base: PointsSchema,
  /** The least stake an item of the tier can have. Tier C is by its own definition the page of the vendor concerned. */
  stakeAtBest: StakeSchema,
});

export const RubricThresholdSchema = z
  .strictObject({
    acceptAt: PointsSchema,
    floorAt: PointsSchema,
    /** Set where one tier alone can be accepted, whatever the score: a derived figure, tier A. */
    onlyTier: EvidenceTierSchema.nullable(),
  })
  .refine((threshold) => threshold.floorAt <= threshold.acceptAt, { message: "the floor is not above the acceptance", path: ["floorAt"] });
export type RubricThreshold = z.infer<typeof RubricThresholdSchema>;

const RecencyWindowSchema = z.strictObject({ withinDays: z.number().int().positive(), factor: RubricFactorSchema });

export const RubricRulesSchema = z.strictObject({
  /** Every tier, with its base score. */
  tiers: z.record(EvidenceTierSchema, RubricTierSchema),
  adjustments: z.strictObject({
    relevance: z.record(RelevanceSchema, RubricFactorSchema),
    recency: z
      .strictObject({
        /** For a fast-moving anchor, by the item's age: the first window it is within. There is always a first. */
        windows: z.tuple([RecencyWindowSchema], RecencyWindowSchema),
        /** Past the last window, and for an item with no date: a price of unknown age is an old price (30 § 3.4, D3). */
        older: RubricFactorSchema,
        /** For an anchor that is not fast-moving, whatever the item's age. */
        stable: RubricFactorSchema,
      })
      .refine((recency) => recency.windows.every((window, index) => index === 0 || window.withinDays > (recency.windows[index - 1]?.withinDays ?? 0)), {
        message: "the windows are in order, each wider than the one before",
        path: ["windows"],
      }),
    independence: z.record(StakeSchema, RubricFactorSchema),
    /** Added once, after the strongest item is chosen, when a second independent item is of `minTier` or above. */
    corroboration: z.strictObject({ bonus: PointsSchema, minTier: EvidenceTierSchema }),
  }),
  /** Per change class; null where no score decides (curator always). */
  thresholds: z.record(ChangeClassSchema, RubricThresholdSchema.nullable()),
});
export type RubricRules = z.infer<typeof RubricRulesSchema>;

/** One item of a worked example: as graded, and its arithmetic. */
export const RubricExampleItemSchema = z
  .strictObject({
    tier: EvidenceTierSchema,
    relevance: RelevanceSchema,
    stake: StakeSchema,
    ageDays: z.number().int().nonnegative().nullable(),
    base: PointsSchema,
    factors: z.strictObject({ relevance: RubricFactorSchema, recency: RubricFactorSchema, independence: RubricFactorSchema }),
    adjusted: PointsSchema,
  })
  .refine((item) => item.adjusted <= item.base, { message: "an adjustment never lifts an item above its base", path: ["adjusted"] });

/** A worked example (§ 5.1, § 7): the numbers the Rubric page prints and the suites recompute. Its words are the page's. */
export const RubricExampleSchema = z
  .strictObject({
    id: SuggestionIdSchema,
    section: SectionIdSchema,
    changeKind: ChangeKindSchema,
    changeClass: ChangeClassSchema,
    fastMoving: z.boolean(),
    items: z.array(RubricExampleItemSchema).min(1),
    score: z.number().int().nonnegative(),
    /** The index of the item that decides, and of the one that corroborates it. */
    strongestItem: z.number().int().nonnegative(),
    corroboratedBy: z.number().int().nonnegative().nullable(),
    acceptAt: PointsSchema.nullable(),
    floorAt: PointsSchema.nullable(),
    route: RouteSchema,
    decision: DecisionSchema,
  })
  .refine((example) => example.strongestItem < example.items.length && (example.corroboratedBy === null || example.corroboratedBy < example.items.length), {
    message: "the strongest and the corroborating item are items of the example",
    path: ["strongestItem"],
  });
export type RubricExample = z.infer<typeof RubricExampleSchema>;

/**
 * The published rubric (§ 5.1): `rubric/<version>/rubric.json`. `chips` maps each of the book's seven source
 * chips to the evidence tier it stands for, or to none (an illustrative figure is an assumption, not evidence);
 * `changelog` is every version to this one with the day it applied, this one last.
 */
export const RubricSchema = z
  .strictObject({
    version: RubricVersionSchema,
    publishedAt: z.iso.date(),
    appliesAt: z.iso.date(),
    ...RubricRulesSchema.shape,
    chips: z.record(SourceTierSchema, EvidenceTierSchema.nullable()),
    examples: z.array(RubricExampleSchema).min(1),
    changelog: z.array(z.strictObject({ version: RubricVersionSchema, on: z.iso.date() })).min(1),
  })
  .refine((rubric) => rubric.publishedAt <= rubric.appliesAt, { message: "a rubric applies on or after the day it is published", path: ["appliesAt"] })
  .refine((rubric) => rubric.changelog[rubric.changelog.length - 1]?.version === rubric.version && rubric.changelog[rubric.changelog.length - 1]?.on === rubric.appliesAt, {
    message: "the changelog ends with this version, on the day it applies",
    path: ["changelog"],
  })
  .refine((rubric) => rubric.changelog.every((entry, index) => index === 0 || entry.on > (rubric.changelog[index - 1]?.on ?? "")), { message: "the changelog is in order of its days", path: ["changelog"] });
export type Rubric = z.infer<typeof RubricSchema>;
