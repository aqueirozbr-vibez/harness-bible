"use client";

import { useTranslations } from "next-intl";
import { useCallback, useSyncExternalStore } from "react";

import { Seg } from "@/components/ui/Seg";
import { KEYS_STORAGE_KEY, THEME_STORAGE_KEY, type ThemeChoice } from "@/lib/theme";

/*
 * Per-device preferences (ui-context § 12, feature-specs/08 § 6.3): the theme
 * (`data-theme` on <html>, `hb.theme`) and the single-key shortcuts (`hb.keys`).
 * Both live in localStorage inside try/catch and default to System / On; the
 * server snapshot is those defaults, so the first paint matches the markup.
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function readKeys(): "on" | "off" {
  try {
    return window.localStorage.getItem(KEYS_STORAGE_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

export function DeviceControls() {
  const t = useTranslations("account.prefs");
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as ThemeChoice);
  const keys = useSyncExternalStore(subscribe, readKeys, () => "on" as const);

  const chooseTheme = useCallback((value: ThemeChoice) => {
    try {
      if (value === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      /* storage unavailable: the choice holds for this page only */
    }
    if (value === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", value);
    notify();
  }, []);

  const chooseKeys = useCallback((value: "on" | "off") => {
    try {
      if (value === "off") window.localStorage.setItem(KEYS_STORAGE_KEY, "off");
      else window.localStorage.removeItem(KEYS_STORAGE_KEY);
    } catch {
      /* nothing to persist to */
    }
    notify();
  }, []);

  return (
    <>
      <div className="between pref-row">
        <span className="flabel" id="pref-theme">
          {t("theme")}
        </span>
        <span className="row" style={{ gap: 10 }}>
          <Seg
            labelledBy="pref-theme"
            value={theme}
            onChange={chooseTheme}
            options={[
              { value: "light", label: t("light") },
              { value: "system", label: t("system") },
              { value: "dark", label: t("dark") },
            ]}
          />
          <span className="meta">{t("scopeDevice")}</span>
        </span>
      </div>
      <div className="between pref-row">
        <span className="flabel" id="pref-keys">
          {t("shortcuts")}
        </span>
        <span className="row" style={{ gap: 10 }}>
          <Seg
            labelledBy="pref-keys"
            value={keys}
            onChange={chooseKeys}
            options={[
              { value: "on", label: t("on") },
              { value: "off", label: t("off") },
            ]}
          />
          <span className="meta">{t("scopeDevice")}</span>
        </span>
      </div>
    </>
  );
}
