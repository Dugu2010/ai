import tseslint from "typescript-eslint";

const eslintConfig = [
  ...tseslint.configs.recommended,
  { ignores: ["dist/**", "node_modules/**", "test/fakes.ts"] },
  {
    rules: {
      // The provider layer deliberately narrows unknown SDK errors.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];

export default eslintConfig;
