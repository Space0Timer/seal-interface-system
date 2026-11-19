import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { mockApiPlugin } from './tools/mock-api/vite-plugin.ts';

// The mock API from the brief runs on the dev and preview servers' own origin.
export default defineConfig({
  plugins: [react(), mockApiPlugin()],
});
