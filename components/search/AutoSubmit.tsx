"use client";

import { useEffect, useRef } from "react";

/** Submits the enclosing filters form on any change; marks the document so the no-JS Apply button hides (feature-specs/06 § 6.7). */
export function AutoSubmit() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    document.documentElement.classList.add("js");
    const form = ref.current?.closest("form");
    if (form === null || form === undefined) return;
    const onChange = () => form.requestSubmit();
    form.addEventListener("change", onChange);
    return () => form.removeEventListener("change", onChange);
  }, []);
  return <span ref={ref} hidden />;
}
