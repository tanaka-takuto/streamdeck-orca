import {
  getWorkspaceStatus,
  type OrcaWorkspace,
  type WorkspaceStatus,
} from "./orca/model";
import type { MonitorState, WorkspaceMonitor } from "./orca/monitor";

export type SavedSelection = { workspaceId: string; workspaceName: string };
export type ControlView = {
  controlId: string;
  workspaceId?: string;
  workspaceName: string;
  workspace?: OrcaWorkspace;
  status: WorkspaceStatus;
  available: number;
  index: number;
  error: string | null;
};

export function normalizeControlId(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "main";
}

export class WorkspaceSelections {
  private readonly listeners = new Map<
    string,
    Set<(view: ControlView) => void>
  >();
  private readonly selections = new Map<string, SavedSelection>();
  private state: MonitorState = { snapshot: null, error: null };
  private catalog: OrcaWorkspace[] = [];
  private ready = false;
  private stopMonitor?: () => void;
  constructor(
    private readonly monitor: WorkspaceMonitor,
    private readonly onChange: (
      id: string,
      selection: SavedSelection,
    ) => void = () => {},
  ) {}

  hydrate(saved: Record<string, SavedSelection>): void {
    if (this.ready) return;
    for (const [id, selection] of Object.entries(saved)) {
      if (
        selection &&
        typeof selection.workspaceId === "string" &&
        typeof selection.workspaceName === "string"
      ) {
        this.selections.set(normalizeControlId(id), { ...selection });
      }
    }
    this.ready = true;
    this.publish();
  }

  subscribe(
    controlId: string,
    listener: (view: ControlView) => void,
  ): () => void {
    const id = normalizeControlId(controlId);
    const first = this.listeners.size === 0;
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    if (first) {
      this.stopMonitor = this.monitor.subscribe((state) => {
        this.state = state;
        this.catalog = [...(state.snapshot?.workspaces ?? [])].sort(
          (a, b) =>
            a.project.localeCompare(b.project) ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id),
        );
        this.publish();
      });
    } else {
      this.ensureSelection(id);
      listener(this.view(id));
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
      if (!this.listeners.size) {
        this.stopMonitor?.();
        this.stopMonitor = undefined;
        this.catalog = [];
        this.state = { snapshot: null, error: null };
      }
    };
  }

  private choose(id: string, workspace: OrcaWorkspace): void {
    const selection = {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    };
    this.selections.set(id, selection);
    this.onChange(id, selection);
  }

  private ensureSelection(id: string): void {
    if (this.ready && !this.selections.has(id) && this.catalog.length)
      this.choose(id, this.catalog[0]);
  }

  private publish(): void {
    for (const [id, listeners] of this.listeners) {
      this.ensureSelection(id);
      const view = this.view(id);
      for (const listener of listeners) listener(view);
    }
  }

  rotate(controlId: string, ticks: number): void {
    if (
      !this.ready ||
      !this.state.snapshot ||
      !this.catalog.length ||
      !Number.isFinite(ticks)
    )
      return;
    const delta = Math.trunc(ticks);
    if (!delta) return;
    const id = normalizeControlId(controlId);
    const selected = this.selections.get(id)?.workspaceId;
    const index = this.catalog.findIndex((row) => row.id === selected);
    const start = index >= 0 ? index : delta > 0 ? -1 : 0;
    const next =
      (((start + delta) % this.catalog.length) + this.catalog.length) %
      this.catalog.length;
    this.choose(id, this.catalog[next]);
    const view = this.view(id);
    for (const listener of this.listeners.get(id) ?? []) listener(view);
  }

  view(controlId: string): ControlView {
    const id = normalizeControlId(controlId);
    const selection = this.selections.get(id);
    const workspace = this.catalog.find(
      (row) => row.id === selection?.workspaceId,
    );
    return {
      controlId: id,
      workspaceId: selection?.workspaceId,
      workspaceName: workspace?.name ?? selection?.workspaceName ?? "候補なし",
      workspace,
      status:
        !this.ready || !this.state.snapshot
          ? "unknown"
          : selection
            ? getWorkspaceStatus(workspace)
            : "idle",
      available: this.catalog.length,
      index: workspace ? this.catalog.indexOf(workspace) : -1,
      error: this.state.error,
    };
  }
}
