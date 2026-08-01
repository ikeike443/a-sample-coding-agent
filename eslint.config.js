import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Browser assets are plain ESM served as-is; they are not part of the Node build.
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "src/dashboard/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
);
