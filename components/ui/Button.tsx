import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "primary" | "quiet" | "destructive";
type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary: "btn-p",
  quiet: "btn-q",
  destructive: "btn-d",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
};

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /** One warm primary per view; destructive is outlined red, never filled. */
  readonly variant?: ButtonVariant;
  /** 36px / 44px / 28px; 44px minimum on touch. */
  readonly size?: ButtonSize;
  /** Render as a link with button styling. */
  readonly href?: string;
  /** A plain `<a>` instead of `next/link`: for route handlers that redirect elsewhere (the sign-in routes), which a client navigation cannot follow. */
  readonly native?: boolean;
  /** A verb that describes the result: "Run", "Save run", "Attach as evidence". */
  readonly children: ReactNode;
  readonly className?: string;
}

/** Button (ui-context § 9.1). */
export function Button({
  variant = "default",
  size = "md",
  href,
  native = false,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = cn("btn", VARIANT_CLASS[variant], SIZE_CLASS[size], className);
  if (href !== undefined && native) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }
  if (href !== undefined) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
