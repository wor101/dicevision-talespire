import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "dist/"] },
  js.configs.recommended,
  {
    // The symbiote: a plain browser script (not a module) inside TaleSpire,
    // which injects the TS API as a global
    files: ["symbiote/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, TS: "readonly" }
    }
  },
  {
    files: ["tests/**/*.mjs", "eslint.config.js"],
    languageOptions: { globals: globals.node }
  }
];
