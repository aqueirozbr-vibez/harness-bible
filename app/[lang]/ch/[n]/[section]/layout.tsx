import type { ReactNode } from "react";

interface SectionLayoutProps {
  readonly children: ReactNode;
  /** Parallel slot for the peek panel; filled by the `(.)ref/[id]` intercept, empty otherwise. */
  readonly peek: ReactNode;
}

/* The assistant's dock is no longer a slot of the section: since feature-specs/24 it is the locale layout's, on every page. */
export default function SectionLayout({ children, peek }: SectionLayoutProps) {
  return (
    <>
      {children}
      {peek}
    </>
  );
}
