import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Product code: what ships in screens and components.
const productCode = ['apps/playground/src/**/*.{ts,tsx}', 'packages/react/src/**/*.{ts,tsx}'];

export default defineConfig(
  globalIgnores(['**/dist/', '**/storybook-static/', '**/playwright-report/', '**/test-results/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  {
    files: productCode,
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
    rules: {
      // Keep design decisions in CSS, where the token lint can see them (P8).
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='style']",
          message: 'Put styles in CSS that uses design tokens (P8). Inline styles bypass the token lint.',
        },
        {
          selector: 'Literal[value=/^#(?:[0-9a-fA-F]{3,4}){1,2}$/]',
          message: 'Raw color in code. Use a color.* token from CSS (P8, B2).',
        },
        {
          selector: 'Literal[value=/^(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\\(/]',
          message: 'Raw color in code. Use a color.* token from CSS (P8, B2).',
        },
      ],
    },
  },
);
