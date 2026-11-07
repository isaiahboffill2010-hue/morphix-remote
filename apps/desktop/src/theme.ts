// Light / dark mode for the kiosk. "auto" follows the system setting.
import { useEffect, useState } from "react";

export type ThemeChoice = "auto" | "light" | "dark";
const KEY = "morphix.theme";

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "auto" ? v : "auto";
  } catch {
    return "auto";
  }
}

const media = () => window.matchMedia?.("(prefers-color-scheme: dark)");
export const resolveTheme = (c: ThemeChoice): "light" | "dark" => (c === "auto" ? (media()?.matches ? "dark" : "light") : c);

/** Shared theme state: every component using it stays in sync. */
const listeners = new Set<(c: ThemeChoice) => void>();
let current: ThemeChoice = read();

function apply(c: ThemeChoice) {
  document.documentElement.dataset.theme = resolveTheme(c);
}
apply(current);
media()?.addEventListener?.("change", () => apply(current));

export function setTheme(c: ThemeChoice) {
  current = c;
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* kiosk storage unavailable: still switch for this session */
  }
  apply(c);
  listeners.forEach((l) => l(c));
}

export function useTheme(): { choice: ThemeChoice; resolved: "light" | "dark"; set: (c: ThemeChoice) => void } {
  const [choice, setChoice] = useState(current);
  useEffect(() => {
    listeners.add(setChoice);
    return () => void listeners.delete(setChoice);
  }, []);
  return { choice, resolved: resolveTheme(choice), set: setTheme };
}
