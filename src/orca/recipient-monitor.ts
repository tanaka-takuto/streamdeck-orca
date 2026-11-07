import type { ActiveRecipient } from "./active-input";

export type RecipientState = {
  recipient: ActiveRecipient | null;
  error: string | null;
  fromCache?: boolean;
};
export type RecipientListener = (state: RecipientState) => void;
const retainedStateLifetimeMs = 5_000;

export class RecipientMonitor {
  state: RecipientState = { recipient: null, error: null };
  private readonly listeners = new Set<RecipientListener>();
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private pending?: { generation: number; promise: Promise<RecipientState> };
  private retained?: { recipient: ActiveRecipient; receivedAt: number };

  constructor(
    private readonly probe: () => Promise<ActiveRecipient>,
    private readonly interval = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(listener: RecipientListener): () => void {
    const first = this.listeners.size === 0;
    if (first) {
      this.generation++;
      const age = this.retained
        ? this.now() - this.retained.receivedAt
        : Infinity;
      if (this.retained && age >= 0 && age < retainedStateLifetimeMs) {
        // ページ切替の再取得中だけ直前の表示を使い、取得時刻は延長しない。
        this.state = {
          recipient: this.retained.recipient,
          error: null,
          fromCache: true,
        };
      } else {
        this.retained = undefined;
        this.state = { recipient: null, error: null };
      }
    }
    this.listeners.add(listener);
    listener(this.state);
    if (first) void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        clearTimeout(this.timer);
        this.generation++;
        this.state = { recipient: null, error: null };
      }
    };
  }

  async refresh(): Promise<RecipientState> {
    if (this.pending?.generation === this.generation)
      return this.pending.promise;
    clearTimeout(this.timer);
    const generation = this.generation;
    const previous = this.pending?.promise;
    const promise = (async () => {
      if (previous) await previous.catch(() => {});
      if (generation !== this.generation) return this.state;
      let next: RecipientState;
      try {
        next = { recipient: await this.probe(), error: null };
      } catch (error) {
        next = {
          recipient: null,
          error:
            error instanceof Error
              ? error.message
              : "Orca の状態を取得できません。",
        };
      }
      if (generation === this.generation) {
        this.state = next;
        this.retained = next.recipient
          ? { recipient: next.recipient, receivedAt: this.now() }
          : undefined;
        for (const listener of this.listeners) listener(next);
      }
      return next;
    })();
    this.pending = { generation, promise };
    try {
      return await promise;
    } finally {
      if (this.pending?.promise === promise) {
        this.pending = undefined;
        if (generation === this.generation && this.listeners.size > 0) {
          this.timer = setTimeout(() => void this.refresh(), this.interval);
          this.timer.unref();
        }
      }
    }
  }
}
