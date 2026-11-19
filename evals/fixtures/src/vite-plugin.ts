// Serves the mock API from the Vite dev and preview servers, on the app's own
// origin, so apps call relative /api/... URLs.
import type { Plugin } from 'vite';
import { createMockApi } from './mock-api.ts';

export function mockApiPlugin(): Plugin {
  const handler = createMockApi();
  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
