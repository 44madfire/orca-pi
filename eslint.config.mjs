// ESLint flat config — OP1.1 scaffold.
// Keeps linting dependency-free of Electron/Orca Desktop.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // third-party/ is a vendored external boundary (see VENDOR.md): Orca's
    // first-party rules do not apply to upstream source.
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.html", "third-party/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
);
