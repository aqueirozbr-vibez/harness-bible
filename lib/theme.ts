/*
 * Theme (ui-context § 12, feature-specs/08 § 6.3): `data-theme` on <html>,
 * persisted per viewer in localStorage under `hb.theme`. The inline script
 * below is the one inline script in the app; it runs before paint with the
 * CSP nonce so the stored theme shows without a flash.
 */

export const THEME_STORAGE_KEY = "hb.theme";
export const KEYS_STORAGE_KEY = "hb.keys";

export type ThemeChoice = "light" | "system" | "dark";

export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}`;
