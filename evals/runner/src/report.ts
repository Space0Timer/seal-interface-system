// Reads a Playwright JSON report into a short summary for the manifest.
import { existsSync, readFileSync } from 'node:fs';

interface JsonResult {
  status: string;
  error?: { message?: string };
  errors?: Array<{ message?: string }>;
}
interface JsonTest {
  projectName: string;
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  results: JsonResult[];
}
interface JsonSpec {
  title: string;
  file: string;
  tests: JsonTest[];
}
interface JsonSuite {
  title: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}
interface JsonReport {
  suites?: JsonSuite[];
  errors?: Array<{ message?: string }>;
  stats?: { expected: number; unexpected: number; flaky: number; skipped: number; duration: number };
}

export interface TestOutcome {
  title: string;
  file: string;
  project: string;
  status: JsonTest['status'];
  error?: string | undefined;
}

export interface TestSummary {
  /** False if no report was written (the runner itself failed). */
  ran: boolean;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  /** Errors outside any test, such as a config error. */
  globalErrors: string[];
  outcomes: TestOutcome[];
  failures: TestOutcome[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const firstLines = (message: string | undefined) =>
  message
    ?.replace(ANSI, '')
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 6)
    .join('\n');

export function summarizeReport(path: string): TestSummary {
  const empty: TestSummary = { ran: false, passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: 0, globalErrors: [], outcomes: [], failures: [] };
  if (!existsSync(path)) return empty;
  const report = JSON.parse(readFileSync(path, 'utf8')) as JsonReport;
  const outcomes: TestOutcome[] = [];
  const visit = (suite: JsonSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results.at(-1);
        const error = last?.error?.message ?? last?.errors?.[0]?.message;
        outcomes.push({ title: spec.title, file: spec.file, project: test.projectName, status: test.status, error: firstLines(error) });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  const count = (status: TestOutcome['status']) => outcomes.filter((o) => o.status === status).length;
  return {
    ran: true,
    passed: count('expected'),
    failed: count('unexpected'),
    flaky: count('flaky'),
    skipped: count('skipped'),
    durationMs: Math.round(report.stats?.duration ?? 0),
    globalErrors: (report.errors ?? []).map((e) => firstLines(e.message) ?? ''),
    outcomes,
    failures: outcomes.filter((o) => o.status === 'unexpected'),
  };
}

export function requireReport(summary: TestSummary, stage: string, exitCode: number | null, projects: string[]): void {
  if (!summary.ran) throw new Error(`${stage} did not write a Playwright report`);
  if (summary.globalErrors.length) throw new Error(`${stage} could not run: ${summary.globalErrors.join('\n')}`);
  if (projects.some((project) => !summary.outcomes.some((outcome) => outcome.project === project))) {
    throw new Error(`${stage} report is missing project results`);
  }
  if (exitCode === null || (exitCode !== 0 && summary.failed === 0)) {
    throw new Error(`${stage} exited without a reported assertion failure (exit ${exitCode})`);
  }
}
