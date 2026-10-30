import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins classes and resolves Tailwind conflicts (the last class wins). Use it
 * wherever classes can conflict, including a className a caller passes to
 * override a base class. Where they can't, as with fixed classes or a
 * caller's margin on a component that sets none, use plain `clsx`: the reader
 * pages do, because tailwind-merge builds its class map on the first call,
 * and on those pages that call would land inside hydration.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
