import { ResearcherError } from "./errors.js";
/** Tombstones matter: the alpha.3 subprocess service MERGES env onto its parent. */
export function gitEnvironment(extra = {}) {
    const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
    return Object.assign(env, {
        PATH: '/usr/bin:/bin:/usr/local/bin', LANG: 'C', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_INDEX_VERSION: '2',
        GIT_ASKPASS: '/bin/false', GIT_SSH_COMMAND: '/bin/false', GIT_PROTOCOL_FROM_USER: '0',
        GIT_AUTHOR_NAME: 'DSH Research', GIT_AUTHOR_EMAIL: 'research@dsh.invalid',
        GIT_COMMITTER_NAME: 'DSH Research', GIT_COMMITTER_EMAIL: 'research@dsh.invalid',
    }, extra);
}
export const GIT_SAFETY_ARGS = [
    '--no-pager', '--no-replace-objects',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'core.attributesFile=/dev/null', '-c', 'core.sparseCheckout=false',
    '-c', 'index.sparse=false', '-c', 'core.splitIndex=false',
    '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'protocol.allow=never', '-c', 'core.logAllRefUpdates=false',
];
/** Production always uses the installed DSH subprocess + sandbox capability seams. */
export function createGitRunner(ctx) {
    return async (command) => {
        const timeout = AbortSignal.timeout(30_000);
        const signal = command.signal === undefined ? timeout : AbortSignal.any([timeout, command.signal]);
        signal.throwIfAborted();
        const executable = await ctx.subprocess.resolveExecutable('git', { PATH: '/usr/bin:/bin:/usr/local/bin' }, signal);
        const exact = [executable, ...command.argv.slice(1)];
        const argv = command.policy.mode === 'danger-full-access' ? exact : ctx.sandbox.confine(exact, {
            ...command.policy, mode: command.policy.mode,
        }).argv;
        const child = ctx.subprocess.spawn({
            argv, cwd: command.cwd, env: command.env, signal, graceMs: 500,
            stdio: { stdin: command.stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' },
        });
        let stdinError;
        child.stdin?.on('error', error => { stdinError = error; });
        if (command.stdin !== undefined)
            child.stdin?.end(command.stdin);
        const collect = async (stream) => {
            if (stream === undefined)
                throw new Error('subprocess did not expose a requested binary pipe');
            const parts = [];
            let bytes = 0;
            for await (const chunk of stream) {
                const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += data.length;
                if (bytes > command.maxOutputBytes) {
                    child.terminate();
                    throw new Error('Git output exceeds checkpoint command limit');
                }
                parts.push(data);
            }
            return Buffer.concat(parts);
        };
        try {
            const [stdout, stderr, outcome] = await Promise.all([collect(child.stdout), collect(child.stderr), child.done]);
            signal.throwIfAborted();
            if (stdinError !== undefined && outcome.exitCode === 0)
                throw stdinError;
            return { stdout, stderr, exitCode: outcome.exitCode };
        }
        catch (error) {
            child.terminate();
            await child.done.catch(() => undefined);
            throw new ResearcherError('confined Git checkpoint command failed', 'RESEARCH_CHECKPOINT_INVALID', { cause: error });
        }
    };
}
//# sourceMappingURL=git-runtime.js.map