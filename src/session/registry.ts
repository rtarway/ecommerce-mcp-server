/**
 * Sessions are issued by this server at `initialize` and must be presented on later calls (MCP spec).
 * Unknown, expired or terminated ids are refused, so guessing or forging a session id gets nothing (C1/M10).
 */
export class SessionCapacityError extends Error {
  constructor() {
    super("session capacity reached");
  }
}

export interface RegistryOptions {
  idleMs: number;
  maxAgeMs: number;
  maxSessions: number;
  maxPerSource: number;
  now?: () => number;
  newId: () => string;
}

interface Entry {
  source: string;
  created: number;
  lastSeen: number;
  /** Customer (`sub`) the session is bound to, from the first authenticated request that used it. */
  owner?: string;
  /** The app's self-declared name from `initialize` (clientInfo.name); a label, not verified. */
  clientName?: string;
}

/** `foreign`: the session belongs to a different principal (or a signed-in session was used anonymously). */
export type SessionCheck = "ok" | "unknown" | "foreign";

export class SessionRegistry {
  private readonly sessions = new Map<string, Entry>();
  private readonly perSource = new Map<string, number>();
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(private readonly opts: RegistryOptions) {
    this.now = opts.now ?? Date.now;
  }

  issue(source: string, owner?: string, clientName?: string): string {
    this.sweep();
    if (this.sessions.size >= this.opts.maxSessions || (this.perSource.get(source) ?? 0) >= this.opts.maxPerSource) {
      throw new SessionCapacityError();
    }
    const id = this.opts.newId();
    const t = this.now();
    this.sessions.set(id, { source, created: t, lastSeen: t, owner, clientName });
    this.perSource.set(source, (this.perSource.get(source) ?? 0) + 1);
    return id;
  }

  /** True when the id was issued by us and is still live; refreshes the idle timer. */
  validate(id: string): boolean {
    return this.check(id) !== "unknown";
  }

  /**
   * Like `validate`, and binds the session to the first customer that uses it (MCP security best practices: bind
   * session ids to the user). A bound session presented by anyone else, or without a token, is `foreign`, so a
   * leaked or guessed id cannot be used to claim, read or fill another customer's cart.
   */
  check(id: string, subject?: string): SessionCheck {
    const e = this.sessions.get(id);
    if (!e) return "unknown";
    const t = this.now();
    if (this.expired(e, t)) {
      this.remove(id);
      return "unknown";
    }
    if (e.owner !== undefined && e.owner !== subject) return "foreign";
    if (e.owner === undefined && subject !== undefined) e.owner = subject;
    e.lastSeen = t;
    return "ok";
  }

  /** The app name the session declared at `initialize`, if any. */
  clientName(id: string): string | undefined {
    return this.sessions.get(id)?.clientName;
  }

  terminate(id: string): void {
    this.remove(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Drops expired sessions. Map iteration is insertion-ordered, so the oldest sessions come first. */
  sweep(): void {
    const t = this.now();
    if (t - this.lastSweep < 1000) return; // a flood must not turn every request into a full scan
    this.lastSweep = t;
    for (const [id, e] of this.sessions) {
      if (this.expired(e, t)) this.remove(id);
    }
  }

  private expired(e: Entry, t: number) {
    return t - e.lastSeen > this.opts.idleMs || t - e.created > this.opts.maxAgeMs;
  }

  private remove(id: string) {
    const e = this.sessions.get(id);
    if (!e) return;
    this.sessions.delete(id);
    const n = (this.perSource.get(e.source) ?? 1) - 1;
    if (n <= 0) this.perSource.delete(e.source);
    else this.perSource.set(e.source, n);
  }
}
