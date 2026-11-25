// One ESLint config for the whole workspace (shared/, gateway/, pwa/).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/coverage/", "**/node_modules/", ".cache/", "shared/src/wudict.schema.d.ts"],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      // Each file is checked with the nearest tsconfig.json.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // Node code: gateway, build scripts and tool configs.
    files: ["gateway/**", "shared/scripts/**", "**/*.config.{js,ts}", "**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["pwa/src/**"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["pwa/src/sw/**"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // shared/ is used by both sides: no Node or DOM globals.
    files: ["shared/src/**"],
    languageOptions: { globals: {} },
  },
  {
    // UI code never calls fetch directly: every request goes through src/api/*.ts (AGENTS.md §5).
    // The service worker (src/sw/) is the network layer itself.
    files: ["pwa/src/**/*.{ts,tsx}"],
    ignores: ["pwa/src/api/**", "pwa/src/sw/**", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Use the adapters in src/api/ instead of calling fetch directly." },
        { name: "XMLHttpRequest", message: "Use the adapters in src/api/." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "fetch", message: "Use the adapters in src/api/." },
        { object: "globalThis", property: "fetch", message: "Use the adapters in src/api/." },
      ],
    },
  },
  {
    // Shipped gateway code logs through src/log.ts.
    files: ["gateway/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "no-console": "error" },
  },
);
