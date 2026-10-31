import * as crypto from 'crypto';
import * as net from 'net';
import * as readline from 'readline';
import type { TraceEvent } from '../../shared/protocol';

/** Messages from a tracer that are not event batches: pauses, inject results, errors. `conn` identifies the process. */
export type TracerMessage = { conn: number } & ({ pause: any } | { injected: any } | { error: any } | { resumed: any });

/**
 * Localhost TCP server the Python tracer connects to. First line must be {"hello": token};
 * then {"events": [...]} batches (re-batched every flushMs) and unbatched control messages.
 * Commands go back on the same socket (`send`).
 */
export class TraceServer {
  readonly token = crypto.randomBytes(16).toString('hex');
  private server: net.Server | undefined;
  private sockets = new Map<number, net.Socket>();   // authed connections by id
  private nextConn = 1;
  private buffer: TraceEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  port = 0;

  constructor(private onEvents: (events: TraceEvent[]) => void, private flushMs: number, private log: (s: string) => void,
    private onMessage: (m: TracerMessage) => void = () => {}, private onHello: (conn: number) => void = () => {}) {}

  async start(): Promise<number> {
    if (this.server) return this.port;
    this.server = net.createServer(sock => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    return this.port;
  }

  get connections() {
    return this.sockets.size;
  }

  /** Send a command to one tracer process, or to all of them. */
  send(cmd: object, conn?: number) {
    const line = JSON.stringify(cmd) + '\n';
    for (const [id, s] of this.sockets) if (conn === undefined || id === conn) s.write(line);
  }

  private accept(sock: net.Socket) {
    let conn = 0;
    sock.on('close', () => { if (conn) this.sockets.delete(conn); });
    sock.on('error', () => sock.destroy());
    const rl = readline.createInterface({ input: sock });
    rl.on('error', () => sock.destroy());   // ECONNRESET when the traced process dies
    rl.on('line', line => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (!conn) {
        if (msg.hello !== this.token) return sock.destroy();
        conn = this.nextConn++;
        this.sockets.set(conn, sock);
        this.log(`tracer connected: pid ${msg.pid}, python ${msg.python}`);
        this.onHello(conn);
        return;
      }
      if (Array.isArray(msg.events)) this.buffer.push(...msg.events);
      else {
        this.flush();   // events before a pause / result must reach the canvas first
        this.onMessage({ conn, ...msg });
      }
    });
  }

  private flush() {
    if (!this.buffer.length) return;
    const events = this.buffer;
    this.buffer = [];
    this.onEvents(events);
  }

  dispose() {
    clearInterval(this.timer);
    this.flush();
    this.sockets.forEach(s => s.destroy());
    this.server?.close();
    this.server = undefined;
  }
}
