/**
 * Detached job runner. The MCP server spawns `node dist/runner.js <taskDir>`
 * detached, so the job survives MCP server restarts. The runner executes the
 * command described in `<taskDir>/job.json`, streams its output to
 * `<taskDir>/output.log`, and records the outcome in `<taskDir>/exit.json`.
 */
import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Job {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    shell?: boolean;
}

export interface ExitRecord {
    exitCode: number | null;
    signal: string | null;
    endedAt: string;
    error?: string;
}

const dir = process.argv[2];
if (!dir) {
    process.stderr.write('usage: runner.js <taskDir>\n');
    process.exit(2);
}

const job = JSON.parse(readFileSync(path.join(dir, 'job.json'), 'utf8')) as Job;
const log = openSync(path.join(dir, 'output.log'), 'a');

const writeExit = (record: Omit<ExitRecord, 'endedAt'>) =>
    writeFileSync(path.join(dir, 'exit.json'), JSON.stringify({ ...record, endedAt: new Date().toISOString() }, null, 2));

const child = spawn(job.command, job.args, {
    cwd: job.cwd,
    env: { ...process.env, ...job.env },
    stdio: ['ignore', log, log],
    windowsHide: true,
    shell: job.shell ?? false
});

child.on('error', err => {
    writeExit({ exitCode: null, signal: null, error: err.message });
    process.exit(1);
});

child.on('exit', (exitCode, signal) => {
    writeExit({ exitCode, signal });
    process.exit(0);
});
