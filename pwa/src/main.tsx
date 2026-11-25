import { render } from "preact";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { initialLocale, setLocale } from "./i18n";
import { applyTheme } from "./lib/theme";
import { setUpdateWaiting } from "./lib/update";
import "./styles.css";

setLocale(initialLocale(navigator.languages));
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  applyTheme();
});

// The service worker (src/sw.ts) is only built for production; registerType "prompt" means a new
// version waits until the user agrees to reload.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const updateSW = registerSW({
    onNeedRefresh() {
      setUpdateWaiting(() => updateSW(true));
    },
  });
}

const root = document.getElementById("app");
if (root) render(<App />, root);
