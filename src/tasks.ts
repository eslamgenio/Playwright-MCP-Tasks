/**
 * Durable task store. Every task lives in `<RUNS_DIR>/<taskId>/`:
 *
 *   task.json      status record (source of truth for the wire Task)
 *   job.json       command the detached runner executes
 *   output.log     combined stdout/stderr of the job
 *   progress.json  live counters written by the Playwright reporter (runs only)
 *   results.json   Playwright JSON report (runs only)
 *   html-report/   Playwright HTML report (runs only)
 *   exit.json      written by the runner when the job exits
 *
 * Because everything is on disk and the job runs in a detached process,
 * `tasks/get` keeps answering after the MCP server restarts.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { isAlive, killTree } from './killTree.js';
import { RUNNER_PATH, RUNS_DIR, taskDir } from './paths.js';
import { countsLine, readJsonReport, summarizeRun, tailFile } from './report.js';
import type { ExitRecord, Job } from './runner.js';

export type TaskKind = 'run' | 'install';
export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];

export interface TaskRecord {
    taskId: string;
    kind: TaskKind;
    status: TaskStatus;
    statusMessage?: string;
    createdAt: string;
    lastUpdatedAt: string;
    pid?: number;
    projectDir: string;
    description: string;
    /** Final tool result, set when status is `completed`. */
    result?: CallToolResult;
    /** JSON-RPC error, set when status is `failed`. */
    error?: { code: number; message: string; data?: unknown };
}

/** Wire shape shared by the tools/call task answer and tasks/get. */
export interface WireTask {
    taskId: string;
    status: TaskStatus;
    statusMessage?: string;
    createdAt: string;
    lastUpdatedAt: string;
    ttlMs: null;
    pollIntervalMs: number;
    result?: CallToolResult;
    error?: { code: number; message: string; data?: unknown };
}

const POLL_INTERVAL_MS: Record<TaskKind, number> = { run: 3000, install: 2000 };
const INTERNAL_ERROR = -32603;

interface Progress {
    total: number;
    done: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    running: string[];
    finished: boolean;
}

export function isTerminal(status: TaskStatus): boolean {
    return TERMINAL.includes(status);
}

function newTaskId(kind: TaskKind): string {
    const d = new Date();
    const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `pw-${kind}-${stamp}-${randomBytes(3).toString('hex')}`;
}

function writeJson(file: string, value: unknown) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

export function loadTask(taskId: string): TaskRecord | undefined {
    return readJson<TaskRecord>(path.join(taskDir(taskId), 'task.json'));
}

function saveTask(task: TaskRecord) {
    writeJson(path.join(taskDir(task.taskId), 'task.json'), task);
}

/**
 * Create a task and start its job in a detached runner. task.json is written
 * before this returns, so the task is durable before the task answer is sent.
 */
export function startTask(opts: {
    kind: TaskKind;
    projectDir: string;
    description: string;
    job: (dir: string) => Job;
}): TaskRecord {
    const taskId = newTaskId(opts.kind);
    const dir = taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const task: TaskRecord = {
        taskId,
        kind: opts.kind,
        status: 'working',
        statusMessage: opts.kind === 'run' ? 'Starting Playwright…' : 'Starting browser install…',
        createdAt: now,
        lastUpdatedAt: now,
        projectDir: opts.projectDir,
        description: opts.description
    };
    writeJson(path.join(dir, 'job.json'), opts.job(dir));
    saveTask(task);

    const runner = spawn(process.execPath, [RUNNER_PATH, dir], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    runner.unref();
    task.pid = runner.pid;
    saveTask(task);
    return task;
}

/** Bring a working task up to date from the files its job writes. */
export function refreshTask(taskId: string): TaskRecord | undefined {
    const task = loadTask(taskId);
    if (!task || isTerminal(task.status)) return task;
    const dir = taskDir(taskId);
    const exit = readJson<ExitRecord>(path.join(dir, 'exit.json'));

    if (exit) {
        finishTask(task, exit);
    } else if (task.pid !== undefined && !isAlive(task.pid)) {
        // Re-check: the runner may have written exit.json just before exiting.
        const late = readJson<ExitRecord>(path.join(dir, 'exit.json'));
        if (late) finishTask(task, late);
        else fail(task, 'The job runner exited without recording a result.', tailFile(path.join(dir, 'output.log'), 2000));
    } else {
        const message = task.kind === 'run' ? runStatusMessage(dir) : installStatusMessage(dir);
        if (message && message !== task.statusMessage) {
            task.statusMessage = message;
            task.lastUpdatedAt = new Date().toISOString();
        }
    }
    saveTask(task);
    return task;
}

function finishTask(task: TaskRecord, exit: ExitRecord) {
    const dir = taskDir(task.taskId);
    const log = tailFile(path.join(dir, 'output.log'), 3000);
    task.lastUpdatedAt = exit.endedAt;

    if (exit.error) return fail(task, `Could not start Playwright: ${exit.error}`, log);

    if (task.kind === 'install') {
        if (exit.exitCode !== 0) return fail(task, `playwright install exited with code ${exit.exitCode}`, log);
        task.status = 'completed';
        task.statusMessage = 'Browsers installed';
        task.result = { content: [{ type: 'text', text: `Browser install finished.\n\n${log}`.trim() }] };
        return;
    }

    const report = readJsonReport(path.join(dir, 'results.json'));
    if (!report?.stats) {
        return fail(task, `Playwright exited with code ${exit.exitCode} before producing a report.`, log);
    }
    const failed = report.stats.unexpected > 0 || (report.errors?.length ?? 0) > 0 || exit.exitCode !== 0;
    task.status = 'completed';
    task.statusMessage = countsLine(report);
    task.result = {
        content: [{ type: 'text', text: summarizeRun(report, { taskId: task.taskId, htmlReportDir: path.join(dir, 'html-report') }) }],
        isError: failed
    };
}

function fail(task: TaskRecord, message: string, log: string) {
    task.status = 'failed';
    task.statusMessage = message;
    task.lastUpdatedAt = new Date().toISOString();
    task.error = { code: INTERNAL_ERROR, message: log ? `${message}\n\nLast output:\n${log}` : message };
}

function runStatusMessage(dir: string): string | undefined {
    const p = readJson<Progress>(path.join(dir, 'progress.json'));
    if (!p) return undefined;
    if (p.finished) return `Finishing: ${p.done}/${p.total} done, writing reports…`;
    const parts = [`${p.done}/${p.total} done`, `${p.passed} passed`];
    if (p.failed) parts.push(`${p.failed} failed`);
    if (p.flaky) parts.push(`${p.flaky} flaky`);
    if (p.skipped) parts.push(`${p.skipped} skipped`);
    let message = parts.join(' · ');
    if (p.running.length) {
        message += ` · running: ${p.running[0]}${p.running.length > 1 ? ` (+${p.running.length - 1} more)` : ''}`;
    }
    return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}

function installStatusMessage(dir: string): string | undefined {
    const lines = tailFile(path.join(dir, 'output.log'), 2000)
        .split(/[\r\n]+/)
        .map(l => l.trim())
        .filter(Boolean);
    const last = lines.at(-1);
    return last ? `Installing: ${last.slice(0, 250)}` : undefined;
}

export function cancelTask(taskId: string): TaskRecord | undefined {
    const task = refreshTask(taskId);
    if (!task || isTerminal(task.status)) return task;
    if (task.pid !== undefined) killTree(task.pid);
    task.status = 'cancelled';
    task.statusMessage = 'Cancelled by client';
    task.lastUpdatedAt = new Date().toISOString();
    saveTask(task);
    return task;
}

export function toWire(task: TaskRecord): WireTask {
    const wire: WireTask = {
        taskId: task.taskId,
        status: task.status,
        createdAt: task.createdAt,
        lastUpdatedAt: task.lastUpdatedAt,
        ttlMs: null,
        pollIntervalMs: POLL_INTERVAL_MS[task.kind]
    };
    if (task.statusMessage) wire.statusMessage = task.statusMessage;
    if (task.status === 'completed' && task.result) wire.result = task.result;
    if (task.status === 'failed') wire.error = task.error ?? { code: INTERNAL_ERROR, message: task.statusMessage ?? 'Task failed' };
    return wire;
}

/** Poll a task until it reaches a terminal status (synchronous tool fallback). */
export async function waitForTask(taskId: string, signal?: AbortSignal): Promise<TaskRecord> {
    for (;;) {
        if (signal?.aborted) return cancelTask(taskId)!;
        const task = refreshTask(taskId)!;
        if (isTerminal(task.status)) return task;
        await new Promise(r => setTimeout(r, 1000));
    }
}

/** Convert a terminal task into a plain tools/call result. */
export function taskToToolResult(task: TaskRecord): CallToolResult {
    if (task.status === 'completed' && task.result) return task.result;
    const message = task.status === 'failed' ? (task.error?.message ?? 'Task failed') : (task.statusMessage ?? `Task ${task.status}`);
    return { content: [{ type: 'text', text: message }], isError: true };
}

/** Most recent tasks first. */
export function listTasks(limit: number): TaskRecord[] {
    if (!existsSync(RUNS_DIR)) return [];
    return readdirSync(RUNS_DIR)
        .filter(name => name.startsWith('pw-') && statSync(path.join(RUNS_DIR, name)).isDirectory())
        .map(name => loadTask(name))
        .filter((t): t is TaskRecord => t !== undefined)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(t => refreshTask(t.taskId) ?? t);
}
