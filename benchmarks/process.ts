import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Execute fixed argv without a shell and retain bounded output. */
export async function execute(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; maxBytes?: number } = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('Invalid process invocation');
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    let stdout = '', stderr = '', bytes = 0, failure: Error | undefined;
    const timer = setTimeout(() => { failure ??= new Error('Process timed out'); child.kill(); }, options.timeoutMs ?? 120000);
    child.on('error', error => { failure ??= error; });
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    for (const [stream, name, decoder] of [[child.stdout, 'stdout', outDecoder], [child.stderr, 'stderr', errDecoder]] as const) {
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { failure ??= new Error('Process output limit exceeded'); child.kill(); return; }
        if (name === 'stdout') stdout += decoder.write(chunk); else stderr += decoder.write(chunk);
      });
    }
    child.on('close', code => {
      clearTimeout(timer);
      stdout += outDecoder.end(); stderr += errDecoder.end();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Process exited ${code}: ${stderr.slice(0, 1000)}`));
      else resolve({ stdout, stderr });
    });
  });
}
