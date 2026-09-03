import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },

    rules: {
      complexity: ["error", 20],

      "no-empty": [
        "error",
        {
          allowEmptyCatch: true,
        },
      ],

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters/**", "**/infrastructure/**", "**/application/**"],
              message: "domain must not depend on outer layers (clean architecture violation)",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters/**"],
              message: "application must not depend on adapters (clean architecture violation)",
            },
          ],
        },
      ],
    },
  },
);