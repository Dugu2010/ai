export default [
  { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parserOptions: { ecmaVersion: 2022 } } },
  { ignores: ['**/node_modules/**', '**/dist/**', 'apps/web/.next/**', '**/node_modules'] }
];
