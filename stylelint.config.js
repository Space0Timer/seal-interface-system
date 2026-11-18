// Product styles must take design decisions from tokens (P8).
// The generated tokens.css is the list of allowed custom properties; run
// `pnpm tokens:build` first.
import { fileURLToPath } from 'node:url';

export default {
  plugins: ['./packages/lint/stylelint-token-values.js'],
  ignoreFiles: ['**/node_modules/**', '**/dist/**', '**/storybook-static/**', '**/playwright-report/**'],
  rules: {
    'ds/token-values': [
      true,
      { tokensCss: fileURLToPath(new URL('./packages/tokens/dist/tokens.css', import.meta.url)) },
    ],
  },
};
