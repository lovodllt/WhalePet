import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class ScreenShare {
  constructor(script, start = () => spawn('/usr/bin/python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] })) {
    this.start = start;
    this.pending = new Map();
    this.nextId = 0;
  }

  authorize() { return this.request('start'); }
  capture() { return this.request('capture'); }

  request(operation) {
    if (!this.child) {
      const child = this.child = this.start();
      child.stderr.resume();
      createInterface({ input: child.stdout }).on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.frames);
      });
      child.stdin.on('error', () => this.end(child));
      child.on('error', () => this.end(child));
      child.on('exit', () => this.end(child));
    }
    const id = ++this.nextId;
    const child = this.child;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, operation }) + '\n', error => { if (error) this.end(child); });
    });
  }

  end(child) {
    if (!child || child !== this.child) return;
    this.child = undefined;
    for (const request of this.pending.values()) request.reject(new Error('屏幕共享已停止'));
    this.pending.clear();
  }

  stop() {
    const child = this.child;
    this.end(child);
    child?.kill();
  }
}
