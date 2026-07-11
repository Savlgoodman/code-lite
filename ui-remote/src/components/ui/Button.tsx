import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  block?: boolean;
}

/** 通用按钮：primary（实心）/ secondary（描边）。 */
export function Button({ variant = "primary", block = false, className = "", ...rest }: ButtonProps) {
  const classes = ["btn", `btn-${variant}`, block ? "btn-block" : "", className]
    .filter(Boolean)
    .join(" ");
  return <button className={classes} {...rest} />;
}
