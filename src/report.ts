/** Helpers that turn Playwright's JSON reporter output into readable text. */
import { existsSync, readFileSync } from 'node:fs';

interface JsonAttachment {
    name: string;
    contentType: string;
    path?: string;
}
interface JsonError {
    message?: string;
    stack?: string;
    location?: { file: string; line: number; column: number };
}
interface JsonResult {
    status: string;
    duration: number;
    retry: number;
    errors?: JsonError[];
    attachments?: JsonAttachment[];
}
interface JsonTest {
    projectName: string;
    status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
    results: JsonResult[];
}
interface JsonSpec {
    title: string;
    file: string;
    line: number;
    tests: JsonTest[];
}
interface JsonSuite {
    title: string;
    file: string;
    specs?: JsonSpec[];
    suites?: JsonSuite[];
}
export interface JsonReport {
    config?: { rootDir?: string };
    suites: JsonSuite[];
    errors?: JsonError[];
    stats?: { startTime: string; duration: number; expected: number; unexpected: number; flaky: number; skipped: number };
}

export interface FlatTest {
    title: string;
    file: string;
    line: number;
    project: string;
    status: JsonTest['status'];
    duration: number;
    retries: number;
    errors: string[];
    attachments: JsonAttachment[];
}

export function readJsonReport(file: string): JsonReport | undefined {
    if (!existsSync(file)) return undefined;
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as JsonReport;
    } catch {
        return undefined;
    }
}

export function stripAnsi(s: string): string {
    return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function flattenReport(report: JsonReport): FlatTest[] {
    const out: FlatTest[] = [];
    const walk = (suite: JsonSuite, titles: string[]) => {
        for (const spec of suite.specs ?? []) {
            for (const test of spec.tests) {
                const last = test.results.at(-1);
                out.push({
                    title: [...titles, spec.title].join(' › '),
                    file: spec.file,
                    line: spec.line,
                    project: test.projectName,
                    status: test.status,
                    duration: test.results.reduce((sum, r) => sum + r.duration, 0),
                    retries: Math.max(0, test.results.length - 1),
                    errors: (last?.errors ?? []).map(e => stripAnsi(e.message ?? e.stack ?? '')).filter(Boolean),
                    attachments: test.results.flatMap(r => r.attachments ?? []).filter(a => a.path)
                });
            }
        }
        for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
    };
    // Top-level suites are files; their title is the file name, which spec.file already carries.
    for (const fileSuite of report.suites) walk(fileSuite, []);
    return out;
}

const STATUS_ICON: Record<FlatTest['status'], string> = {
    expected: '✓',
    unexpected: '✗',
    flaky: '~',
    skipped: '-'
};

function testLabel(t: FlatTest): string {
    return `${t.file}:${t.line} › ${t.title}${t.project ? ` [${t.project}]` : ''}`;
}

export function formatDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function countsLine(report: JsonReport): string {
    const s = report.stats;
    if (!s) return '';
    const total = s.expected + s.unexpected + s.flaky + s.skipped;
    return `${total} tests: ${s.expected} passed, ${s.unexpected} failed, ${s.flaky} flaky, ${s.skipped} skipped in ${formatDuration(s.duration)}`;
}

/** Short summary used as the task's final tool result. */
export function summarizeRun(report: JsonReport, opts: { taskId: string; htmlReportDir: string; maxFailures?: number }): string {
    const tests = flattenReport(report);
    const failures = tests.filter(t => t.status === 'unexpected');
    const flaky = tests.filter(t => t.status === 'flaky');
    const lines = [`Playwright run ${opts.taskId}: ${countsLine(report)}`];
    if (failures.length) {
        lines.push('', `Failed tests (${failures.length}):`);
        for (const t of failures.slice(0, opts.maxFailures ?? 10)) {
            lines.push(`✗ ${testLabel(t)}`);
            const err = t.errors[0];
            if (err) lines.push(indent(err.split('\n').slice(0, 8).join('\n'), '    '));
        }
        if (failures.length > (opts.maxFailures ?? 10)) lines.push(`… and ${failures.length - (opts.maxFailures ?? 10)} more`);
    }
    if (flaky.length) {
        lines.push('', `Flaky tests (${flaky.length}):`, ...flaky.map(t => `~ ${testLabel(t)}`));
    }
    for (const e of report.errors ?? []) lines.push('', `Global error: ${stripAnsi(e.message ?? '')}`);
    if (existsSync(opts.htmlReportDir)) {
        lines.push('', `HTML report: ${opts.htmlReportDir}`, `Open it with: npx playwright show-report "${opts.htmlReportDir}"`);
    }
    lines.push(`Full details: call get_run_report with runId "${opts.taskId}".`);
    return lines.join('\n');
}

/** Detailed per-test report for get_run_report. */
export function detailedReport(report: JsonReport, onlyFailures: boolean): string {
    const tests = flattenReport(report).filter(t => !onlyFailures || t.status === 'unexpected' || t.status === 'flaky');
    const lines = [countsLine(report), ''];
    if (!tests.length) lines.push(onlyFailures ? 'No failed or flaky tests.' : 'No tests in report.');
    for (const t of tests) {
        lines.push(`${STATUS_ICON[t.status]} ${testLabel(t)} (${formatDuration(t.duration)}${t.retries ? `, ${t.retries} retries` : ''})`);
        for (const err of t.errors) lines.push(indent(err, '    '));
        for (const a of t.attachments) lines.push(`    📎 ${a.name} (${a.contentType}): ${a.path}`);
    }
    for (const e of report.errors ?? []) lines.push('', `Global error: ${stripAnsi(e.message ?? '')}`);
    return lines.join('\n');
}

/** Format `playwright test --list --reporter=json` output. */
export function formatTestList(report: JsonReport): string {
    const tests = flattenReport(report);
    const byFile = new Map<string, FlatTest[]>();
    for (const t of tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
    const lines = [`${tests.length} tests in ${byFile.size} files`];
    for (const [file, list] of byFile) {
        lines.push('', file);
        for (const t of list) lines.push(`  :${t.line} ${t.title}${t.project ? ` [${t.project}]` : ''}`);
    }
    for (const e of report.errors ?? []) lines.push('', `Error: ${stripAnsi(e.message ?? '')}`);
    return lines.join('\n');
}

export function tailFile(file: string, maxChars = 4000): string {
    if (!existsSync(file)) return '';
    const text = readFileSync(file, 'utf8');
    return stripAnsi(text.length > maxChars ? text.slice(-maxChars) : text);
}

function indent(s: string, prefix: string): string {
    return s
        .split('\n')
        .map(l => prefix + l)
        .join('\n');
}
