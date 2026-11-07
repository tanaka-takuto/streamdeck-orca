import type { OrcaClient } from "./client";
import type { OrcaSnapshot } from "./model";

export type MonitorState = {
  snapshot: OrcaSnapshot | null;
  error: string | null;
  fromCache?: boolean;
};
export type MonitorListener = (state: MonitorState) => void;
const retainedStateLifetimeMs = 5_000;

export class WorkspaceMonitor {
  state: MonitorState = { snapshot: null, error: null };
  private readonly listeners = new Set<MonitorListener>();
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private pending?: { generation: number; promise: Promise<MonitorState> };
  private retained?: { snapshot: OrcaSnapshot; receivedAt: number };

  constructor(
    private readonly client: Pick<OrcaClient, "snapshot">,
    private readonly interval = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(listener: MonitorListener): () => void {
    const first = this.listeners.size === 0;
    if (first) {
      this.generation++;
      const age = this.retained
        ? this.now() - this.retained.receivedAt
        : Infinity;
      if (this.retained && age >= 0 && age < retainedStateLifetimeMs) {
        // ページ切替の再取得中だけ直前の表示を使い、取得時刻は延長しない。
        this.state = {
          snapshot: this.retained.snapshot,
          error: null,
          fromCache: true,
        };
      } else {
        this.retained = undefined;
        this.state = { snapshot: null, error: null };
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
        this.state = { snapshot: null, error: null };
      }
    };
  }

  async refresh(): Promise<MonitorState> {
    if (this.pending?.generation === this.generation)
      return this.pending.promise;
    clearTimeout(this.timer);
    const generation = this.generation;
    const promise = (async () => {
      let next: MonitorState;
      try {
        next = { snapshot: await this.client.snapshot(), error: null };
      } catch (error) {
        next = {
          snapshot: null,
          error:
            error instanceof Error
              ? error.message
              : "Orca の状態を取得できません。",
        };
      }
      if (generation === this.generation) {
        this.state = next;
        this.retained = next.snapshot
          ? { snapshot: next.snapshot, receivedAt: this.now() }
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
