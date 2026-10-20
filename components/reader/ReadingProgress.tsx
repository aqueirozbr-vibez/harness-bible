"use client";

import { useReadingProgress } from "@/lib/hooks/useReadingProgress";

interface ReadingProgressProps {
  readonly sectionId: string;
  readonly locale: string;
  readonly record: (input: { sectionId: string; locale: string }) => Promise<unknown>;
}

/** Mounts the progress recorder for a signed-in reader; renders nothing. */
export function ReadingProgress({ sectionId, locale, record }: ReadingProgressProps) {
  useReadingProgress(sectionId, locale, record, true);
  return null;
}
