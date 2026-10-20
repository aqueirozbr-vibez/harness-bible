-- One ChapterVersion per chapter per release (architecture invariant 1): an unchanged chapter keeps its version in
-- the next release (feature-specs/04 § 6.10), so a version is not unique per chapter. Found by unit 54c's first merge,
-- whose release re-inserted forty unchanged chapters. Relaxing (invariant 30): every existing row stays valid, and
-- "ChapterVersion_chapterNumber_releaseId_key" still holds one row per chapter per release.
DROP INDEX "ChapterVersion_chapterNumber_version_key";
