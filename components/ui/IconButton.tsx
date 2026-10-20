import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "aria-label"> {
  /** Required accessible name, localised: "Close peek panel". */
  readonly label: string;
  /** An inline 12px stroke SVG or a text glyph such as `×` or `⇤`. */
  readonly children: ReactNode;
  readonly className?: string;
}

/** 32px icon-only button; always labelled (ui-context § 9.1, § 13.4). */
export function IconButton({ label, children, className, type = "button", ...rest }: IconButtonProps) {
  return (
    <button type={type} className={cn("iconbtn", className)} aria-label={label} {...rest}>
      {children}
    </button>
  );
}
