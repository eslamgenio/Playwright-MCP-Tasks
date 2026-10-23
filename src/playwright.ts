/** Builds Playwright command lines for the runner and for synchronous calls. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { findPlaywrightCli, REPORTER_PATH } from './paths.js';
import type { Job } from './runner.js';

export interface RunTestsOptions {
    files?: string[];
    grep?: string;
    grepInvert?: string;
    project?: string[];
    workers?: number;
    retries?: number;
    headed?: boolean;
    timeoutMinutes?: number;
}

export interface InstallOptions {
    browsers?: string[];
    withDeps?: boolean;
}

/** `node <cli.js> ...args`, or `npx playwright ...args` when the CLI isn't resolvable. */
function playwrightCommand(projectDir: string, args: string[]): Pick<Job, 'command' | 'args' | 'shell'> {
    const cli = findPlaywrightCli(projectDir);
    if (cli) return { command: process.execPath, args: [cli, ...args] };
    return { command: 'npx', args: ['--yes', 'playwright', ...args.map(quoteForShell)], shell: true };
}

function quoteForShell(arg: string): string {
    return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export function testFilterArgs(opts: Pick<RunTestsOptions, 'files' | 'grep' | 'grepInvert' | 'project'>): string[] {
    const args = [...(opts.files ?? [])];
    if (opts.grep) args.push('--grep', opts.grep);
    if (opts.grepInvert) args.push('--grep-invert', opts.grepInvert);
    for (const p of opts.project ?? []) args.push('--project', p);
    return args;
}

export function runTestsJob(projectDir: string, taskDir: string, opts: RunTestsOptions): Job {
    const args = ['test', ...testFilterArgs(opts), `--reporter=${REPORTER_PATH},json,html`, '--output', path.join(taskDir, 'test-results')];
    if (opts.workers !== undefined) args.push('--workers', String(opts.workers));
    if (opts.retries !== undefined) args.push('--retries', String(opts.retries));
    if (opts.headed) args.push('--headed');
    if (opts.timeoutMinutes !== undefined) args.push('--global-timeout', String(Math.round(opts.timeoutMinutes * 60_000)));
    return {
        ...playwrightCommand(projectDir, args),
        cwd: projectDir,
        env: {
            PW_MCP_PROGRESS_FILE: path.join(taskDir, 'progress.json'),
            PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(taskDir, 'results.json'),
            PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(taskDir, 'html-report'),
            PLAYWRIGHT_HTML_OPEN: 'never',
            FORCE_COLOR: '0'
        }
    };
}

export function installJob(projectDir: string, opts: InstallOptions): Job {
    const args = ['install', ...(opts.withDeps ? ['--with-deps'] : []), ...(opts.browsers ?? [])];
    return { ...playwrightCommand(projectDir, args), cwd: projectDir, env: { FORCE_COLOR: '0' } };
}

/** Run a short Playwright command and capture its output (used by list_tests). */
export function runPlaywright(
    projectDir: string,
    args: string[],
    signal?: AbortSignal
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const cmd = playwrightCommand(projectDir, args);
    return new Promise((resolve, reject) => {
        const child = spawn(cmd.command, cmd.args, {
            cwd: projectDir,
            env: { ...process.env, FORCE_COLOR: '0' },
            shell: cmd.shell ?? false,
            windowsHide: true,
            signal
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => (stdout += d));
        child.stderr.on('data', d => (stderr += d));
        child.on('error', reject);
        child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
    });
}
