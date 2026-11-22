import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['vendor/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], eqeqeq: 'error', 'prefer-const': 'error' },
  },
  { files: ['js/**'], languageOptions: { globals: { ...globals.browser, ...globals.worker } } },
  { files: ['tests/**', 'eslint.config.js'], languageOptions: { globals: globals.node } },
];
