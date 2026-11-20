export const MOCK_ADMIN_HEADER = 'x-mock-control';

/** Only Playwright's Node-side fixture requests get the control credential. */
export function mockControlHeaders(): Record<string, string> {
  const token = process.env['EVAL_MOCK_ADMIN_TOKEN'];
  return token ? { [MOCK_ADMIN_HEADER]: token } : {};
}
