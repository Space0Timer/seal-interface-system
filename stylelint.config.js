// Product styles must take design decisions from tokens (P8).
// The generated tokens.css is the list of allowed custom properties; run
// `pnpm tokens:build` first.
import { fileURLToPath } from 'node:url';

export default {
  plugins: ['./packages/lint/stylelint-token-values.js'],
  // evals/results/ holds generators' output, which is linted per run with
  // the run's own rules, never by the repo's check.
  ignoreFiles: ['**/node_modules/**', '**/dist/**', '**/storybook-static/**', '**/playwright-report/**', 'evals/results/**'],
  rules: {
    'ds/token-values': [
      true,
      { tokensCss: fileURLToPath(new URL('./packages/tokens/dist/tokens.css', import.meta.url)) },
    ],
  },
};
