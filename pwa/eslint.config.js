import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "src/api/*.schema.d.ts"] },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // UI code never calls fetch directly: every request goes through src/api/*.ts (AGENTS.md §5).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/api/**"],
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
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      // Tests stub globals such as fetch.
      "no-restricted-globals": "off",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: globals.node },
  },
);
