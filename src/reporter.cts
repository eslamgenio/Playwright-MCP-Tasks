/**
 * Playwright reporter that writes live progress to the file named by
 * PW_MCP_PROGRESS_FILE. The MCP server reads it to build each task's
 * statusMessage. CommonJS so Playwright can load it from any project.
 */
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig, Reporter, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

interface Progress {
    total: number;
    done: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    running: string[];
    failures: { title: string; error: string }[];
    finished: boolean;
    status?: string;
    updatedAt: string;
}

const MIN_WRITE_INTERVAL_MS = 500;

class ProgressReporter implements Reporter {
    private file = process.env.PW_MCP_PROGRESS_FILE;
    private rootDir = '';
    private progress: Progress = {
        total: 0,
        done: 0,
        passed: 0,
        failed: 0,
        flaky: 0,
        skipped: 0,
        running: [],
        failures: [],
        finished: false,
        updatedAt: new Date().toISOString()
    };
    private running = new Map<string, string>();
    private lastWrite = 0;
    private pending?: NodeJS.Timeout;

    onBegin(config: FullConfig, suite: Suite) {
        this.rootDir = config.rootDir;
        this.progress.total = suite.allTests().length;
        this.write(true);
    }

    onTestBegin(test: TestCase) {
        this.running.set(test.id, this.title(test));
        this.write();
    }

    onTestEnd(test: TestCase, result: TestResult) {
        // Retries report onTestEnd once per attempt; only the last attempt counts.
        const willRetry = result.status !== 'passed' && result.status !== 'skipped' && result.retry < test.retries;
        if (willRetry) return;
        this.running.delete(test.id);
        this.progress.done++;
        const outcome = test.outcome();
        if (outcome === 'expected') this.progress.passed++;
        else if (outcome === 'flaky') this.progress.flaky++;
        else if (outcome === 'skipped') this.progress.skipped++;
        else {
            this.progress.failed++;
            const message = result.errors[0]?.message ?? result.error?.message ?? result.status;
            this.progress.failures.push({ title: this.title(test), error: stripAnsi(message).slice(0, 500) });
        }
        this.write();
    }

    onEnd(result: FullResult) {
        this.running.clear();
        this.progress.finished = true;
        this.progress.status = result.status;
        this.write(true);
    }

    printsToStdio() {
        return false;
    }

    private title(test: TestCase): string {
        const file = path.relative(this.rootDir, test.location.file).replace(/\\/g, '/');
        // titlePath() is [root, project, file, ...describes, title].
        const [, project, , ...titles] = test.titlePath();
        return `${file} › ${titles.join(' › ')}${project ? ` [${project}]` : ''}`;
    }

    private write(force = false) {
        if (!this.file) return;
        const now = Date.now();
        if (!force && now - this.lastWrite < MIN_WRITE_INTERVAL_MS) {
            this.pending ??= setTimeout(() => {
                this.pending = undefined;
                this.write(true);
            }, MIN_WRITE_INTERVAL_MS);
            return;
        }
        if (this.pending) {
            clearTimeout(this.pending);
            this.pending = undefined;
        }
        this.lastWrite = now;
        this.progress.running = [...this.running.values()];
        this.progress.updatedAt = new Date().toISOString();
        const tmp = `${this.file}.tmp`;
        try {
            writeFileSync(tmp, JSON.stringify(this.progress, null, 2));
            renameSync(tmp, this.file);
        } catch {
            // Progress is best effort; never fail the run because of it.
        }
    }
}

function stripAnsi(s: string): string {
    return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export = ProgressReporter;
