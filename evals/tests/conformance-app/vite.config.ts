import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { mockApiPlugin } from '../../fixtures/src/vite-plugin.ts';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [mockApiPlugin()],
});
