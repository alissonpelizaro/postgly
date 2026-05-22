import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, resolving Tailwind conflicts so the last wins.
 * The standard shadcn/ui helper — used by every UI component.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
