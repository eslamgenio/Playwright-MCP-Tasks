/**
 * End-to-end smoke test. Speaks raw JSON-RPC over stdio on protocol revision
 * 2026-07-28, the way Claude Code does, because the SDK client does not accept
 * `resultType: "task"` answers.
 *
 *   npm run smoke
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isAlive } from './killTree.js';
import { ROOT_DIR, taskDir } from './paths.js';
import { loadTask } from './tasks.js';

const SERVER = path.join(ROOT_DIR, 'dist', 'index.js');
const TASKS = 'io.modelcontextprotocol/tasks';

function envelope(withTasks: boolean) {
    return {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'smoke', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': withTasks ? { extensions: { [TASKS]: {} } } : {}
    };
}

class RawClient {
    private proc: ChildProcess;
    private nextId = 1;
    private pending = new Map<number, (msg: any) => void>();
    private buf = '';

    constructor() {
        this.proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
        this.proc.stdout!.setEncoding('utf8');
        this.proc.stdout!.on('data', (chunk: string) => {
            this.buf += chunk;
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i).trim();
                this.buf = this.buf.slice(i + 1);
                if (!line) continue;
                const msg = JSON.parse(line);
                if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
            }
        });
    }

    request(method: string, params: Record<string, unknown> = {}, withTasks = true): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10 * 60_000);
            this.pending.set(id, msg => {
                clearTimeout(timer);
                this.pending.delete(id);
                resolve(msg);
            });
            this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: envelope(withTasks) } }) + '\n');
        });
    }

    async ok(method: string, params: Record<string, unknown> = {}, withTasks = true) {
        const msg = await this.request(method, params, withTasks);
        if (msg.error) throw new Error(`${method} failed: ${JSON.stringify(msg.error)}`);
        return msg.result;
    }

    close() {
        this.proc.kill();
    }
}

let failures = 0;
function check(cond: unknown, label: string) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function pollUntilTerminal(client: RawClient, taskId: string, onStatus?: (t: any) => void) {
    for (;;) {
        const t = await client.ok('tasks/get', { taskId });
        onStatus?.(t);
        if (['completed', 'failed', 'cancelled'].includes(t.status)) return t;
        await sleep(t.pollIntervalMs ?? 2000);
    }
}

async function main() {
    let client = new RawClient();

    // 1. Discovery advertises the tasks extension.
    const discover = await client.ok('server/discover');
    check(discover.supportedVersions?.includes('2026-07-28'), 'server/discover offers 2026-07-28');
    check(discover.capabilities?.extensions?.[TASKS], 'server/discover advertises the tasks extension');

    // 2. list_tests is a plain synchronous tool.
    const list = await client.ok('tools/call', { name: 'list_tests', arguments: {} });
    console.log(list.content[0].text.split('\n').slice(0, 3).join('\n'));
    check(list.resultType === 'complete' && /10 tests in 3 files/.test(list.content[0].text), 'list_tests lists the demo suite');

    // 3. run_tests answers with a task and completes via tasks/get.
    const handle = await client.ok('tools/call', { name: 'run_tests', arguments: {} });
    check(handle.resultType === 'task', 'run_tests answers with resultType "task"');
    check(
        typeof handle.taskId === 'string' && handle.status === 'working' && handle.createdAt && handle.lastUpdatedAt && handle.ttlMs === null,
        'task handle carries taskId, status, createdAt, lastUpdatedAt, ttlMs'
    );
    check(!('result' in handle) && !('error' in handle), 'task handle has no result/error');

    // 4. Durability: restart the server mid-run and keep polling the same task.
    await sleep(8000);
    const before = await client.ok('tasks/get', { taskId: handle.taskId });
    console.log(`      status before restart: ${before.statusMessage}`);
    client.close();
    client = new RawClient();
    await client.ok('server/discover');

    const messages = new Set<string>();
    const done = await pollUntilTerminal(client, handle.taskId, t => {
        if (t.statusMessage && !messages.has(t.statusMessage)) {
            messages.add(t.statusMessage);
            console.log(`      ${t.status}: ${t.statusMessage}`);
        }
    });
    check(done.resultType === 'complete', 'tasks/get answers with resultType "complete"');
    check(done.status === 'completed', 'run task completed after a server restart');
    check(messages.size >= 3, `statusMessage progressed (${messages.size} distinct messages)`);
    check(done.result?.isError === true && /1 failed/.test(done.result.content[0].text), 'result reports the intentional @failing test');
    console.log(done.result?.content[0].text);

    // 5. get_run_report returns failure details for that run.
    const report = await client.ok('tools/call', { name: 'get_run_report', arguments: { runId: handle.taskId, onlyFailures: true } });
    check(/applies a discount code/.test(report.content[0].text), 'get_run_report shows the failing test');

    // 6. Cancellation kills the process tree.
    const second = await client.ok('tools/call', { name: 'run_tests', arguments: { grepInvert: '@failing' } });
    await sleep(6000);
    const pid = loadTask(second.taskId)?.pid;
    const cancelAck = await client.ok('tasks/cancel', { taskId: second.taskId });
    check(cancelAck && Object.keys(cancelAck).filter(k => k !== '_meta' && k !== 'resultType').length === 0, 'tasks/cancel acknowledges with an empty result');
    const cancelled = await client.ok('tasks/get', { taskId: second.taskId });
    check(cancelled.status === 'cancelled', 'cancelled task reports status "cancelled"');
    await sleep(1500);
    check(pid !== undefined && !isAlive(pid), 'runner process tree is gone after cancel');
    check(!existsSync(path.join(taskDir(second.taskId), 'exit.json')), 'cancelled run did not finish');

    // 7. Unknown task IDs answer -32602.
    const bogus = await client.request('tasks/get', { taskId: 'pw-run-does-not-exist' });
    check(bogus.error?.code === -32602, 'unknown taskId answers -32602');

    // 8. Without the extension the tool blocks and returns a plain result.
    const plain = await client.ok('tools/call', { name: 'run_tests', arguments: { grep: 'starts empty' } }, false);
    check(plain.resultType === 'complete' && plain.content?.[0]?.text?.includes('1 passed'), 'run_tests without the tasks extension returns a plain result');

    client.close();
    console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
