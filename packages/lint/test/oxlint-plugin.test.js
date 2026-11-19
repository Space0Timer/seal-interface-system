import { describe, it } from 'node:test';
import { RuleTester } from 'oxlint/plugins-dev';
import plugin from '../oxlint-plugin.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester();

tester.run('ds/no-inline-style', plugin.rules['no-inline-style'], {
  valid: [
    { filename: 'Row.tsx', code: 'const row = <li className="row">campaign-header.png</li>;' },
    { filename: 'Row.tsx', code: 'const styles = { row: "row" }; const row = <li className={styles.row} />;' },
  ],
  invalid: [
    {
      filename: 'Row.tsx',
      code: 'const row = <li style={{ paddingBlock: 12 }} />;',
      errors: [{ messageId: 'inlineStyle' }],
    },
    {
      filename: 'Row.tsx',
      code: 'const row = <Thumbnail style={{}} />;',
      errors: [{ messageId: 'inlineStyle' }],
    },
  ],
});

tester.run('ds/no-raw-color', plugin.rules['no-raw-color'], {
  valid: [
    { filename: 'Row.tsx', code: 'const label = "#3 of 12";' },
    { filename: 'Row.tsx', code: 'const id = "#asset-42";' },
    { filename: 'Row.tsx', code: 'const tone = "var(--color-text-secondary)";' },
    { filename: 'Row.tsx', code: 'const count = 0xfff;' },
  ],
  invalid: [
    { filename: 'Row.tsx', code: 'const a = "#fff";', errors: [{ messageId: 'rawColor' }] },
    { filename: 'Row.tsx', code: 'const a = "#1a2b3c80";', errors: [{ messageId: 'rawColor' }] },
    { filename: 'Row.tsx', code: 'const a = "rgb(0 0 0 / 50%)";', errors: [{ messageId: 'rawColor' }] },
    { filename: 'Row.tsx', code: 'const a = "oklch(62% 0.2 250)";', errors: [{ messageId: 'rawColor' }] },
    { filename: 'Row.tsx', code: 'const a = <svg fill="#000" />;', errors: [{ messageId: 'rawColor' }] },
  ],
});
