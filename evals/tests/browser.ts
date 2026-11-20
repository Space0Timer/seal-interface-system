import { test as base } from '@playwright/test';

export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    if (process.env['EVAL_MOCK_ADMIN_TOKEN'] && baseURL) {
      const origin = new URL(baseURL).origin;
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'),
      );
      await context.routeWebSocket('**/*', (socket) => socket.close());
    }
    await use(context);
  },
});
