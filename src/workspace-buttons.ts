import type { OrcaClient } from "./orca/client";
import { getWorkspaceStatus, type WorkspaceStatus } from "./orca/model";
import type { MonitorState, WorkspaceMonitor } from "./orca/monitor";

export type WorkspaceSettings = {
  workspaceId?: string;
  workspaceName?: string;
};
export type WorkspaceKey = {
  id: string;
  setImage(image: string): Promise<void>;
  showAlert(): Promise<void>;
  showOk?(): Promise<void>;
};

type DisplayStatus = WorkspaceStatus | "unassigned";
type Binding = {
  key: WorkspaceKey;
  settings: WorkspaceSettings;
  stop?: () => void;
  renderVersion: number;
  desiredImage?: string;
  display?: { name: string; status: DisplayStatus };
  busy: boolean;
};

const styles: Record<
  DisplayStatus,
  { color: string; symbol: string; lines: string[] }
> = {
  working: { color: "#145c9e", symbol: "", lines: ["進行中"] },
  waiting: { color: "#965200", symbol: "?", lines: ["入力待ち"] },
  review: { color: "#086a64", symbol: "!", lines: ["返答あり", "要確認"] },
  idle: { color: "#374151", symbol: "−", lines: ["待機"] },
  unknown: { color: "#55384f", symbol: "?", lines: ["状態不明"] },
  unassigned: { color: "#30343b", symbol: "−", lines: ["候補なし"] },
};

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character] ?? character,
  );
}

export function keyImage(
  name: string,
  status: DisplayStatus,
  frame = 0,
): string {
  const style = styles[status];
  const title = Array.from(name).slice(0, 12).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" rx="16" fill="${style.color}"/>
<g fill="#fff" font-family="sans-serif" text-anchor="middle">
<text x="72" y="25" font-size="16">${escapeXml(title)}</text>
${
  status === "working"
    ? `<g fill="none" stroke="#fff" stroke-width="6"><circle cx="72" cy="61" r="22" opacity="0.25"/><path d="M72 39 A22 22 0 0 1 94 61" stroke-linecap="round" transform="rotate(${(frame % 12) * 30} 72 61)"/></g>`
    : `<text x="72" y="77" font-size="43" font-weight="bold">${style.symbol}</text>`
}
${style.lines.map((line, index) => `<text x="72" y="${style.lines.length === 1 ? 119 : 107 + index * 23}" font-size="21">${line}</text>`).join("")}
</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export class WorkspaceButtons {
  private readonly bindings = new Map<string, Binding>();
  private readonly renders = new Map<string, Promise<void>>();
  private navigationVersion = 0;
  private animationTimer?: ReturnType<typeof setInterval>;
  private animationFrame = 0;
  private animationBusy = false;
  constructor(
    private readonly monitor: WorkspaceMonitor,
    private readonly client: Pick<OrcaClient, "focusWorkspace">,
    private readonly onError: (
      actionId: string,
      message: string,
    ) => void = () => {},
  ) {}

  bind(key: WorkspaceKey, settings: WorkspaceSettings): void {
    this.unbind(key.id);
    const binding: Binding = {
      key,
      settings: { ...settings },
      renderVersion: 0,
      busy: false,
    };
    this.bindings.set(key.id, binding);
    binding.stop = this.monitor.subscribe((state) =>
      this.render(binding, state),
    );
  }

  unbind(actionId: string): void {
    const binding = this.bindings.get(actionId);
    this.bindings.delete(actionId);
    binding?.stop?.();
    this.updateAnimation();
  }

  private render(binding: Binding, state: MonitorState): void {
    if (this.bindings.get(binding.key.id) !== binding) return;
    const workspace = state.snapshot?.workspaces.find(
      (row) => row.id === binding.settings.workspaceId,
    );
    const status = binding.settings.workspaceId
      ? getWorkspaceStatus(workspace)
      : state.snapshot
        ? "unassigned"
        : "unknown";
    binding.display = {
      name: workspace?.name ?? binding.settings.workspaceName ?? "Workspace",
      status,
    };
    void this.draw(binding);
    this.updateAnimation();
  }

  private updateAnimation(): void {
    const working = [...this.bindings.values()].some(
      (binding) => binding.display?.status === "working",
    );
    if (!working) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    } else if (!this.animationTimer) {
      this.animationTimer = setInterval(() => void this.animate(), 100);
      this.animationTimer.unref?.();
    }
  }

  private async animate(): Promise<void> {
    if (this.animationBusy) return;
    this.animationBusy = true;
    this.animationFrame = (this.animationFrame + 1) % 12;
    try {
      // 送信が遅いときはフレームを飛ばし、待ち行列を増やさない。
      await Promise.all(
        [...this.bindings.values()]
          .filter((binding) => binding.display?.status === "working")
          .map((binding) => this.draw(binding)),
      );
    } finally {
      this.animationBusy = false;
    }
  }

  private draw(binding: Binding): Promise<void> {
    if (!binding.display || this.bindings.get(binding.key.id) !== binding)
      return Promise.resolve();
    const image = keyImage(
      binding.display.name,
      binding.display.status,
      this.animationFrame,
    );
    if (binding.desiredImage === image)
      return this.renders.get(binding.key.id) ?? Promise.resolve();
    binding.desiredImage = image;
    const version = ++binding.renderVersion;
    const current = () =>
      this.bindings.get(binding.key.id) === binding &&
      binding.renderVersion === version;
    const previous = this.renders.get(binding.key.id) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (!current()) return;
        await binding.key.setImage(image);
      })
      .catch((error: unknown) => {
        if (current()) {
          binding.desiredImage = undefined;
          this.onError(
            binding.key.id,
            error instanceof Error
              ? error.message
              : "キー表示を更新できません。",
          );
        }
      });
    this.renders.set(binding.key.id, next);
    void next.then(() => {
      if (this.renders.get(binding.key.id) === next)
        this.renders.delete(binding.key.id);
    });
    return next;
  }

  async press(actionId: string, isActive = () => true): Promise<void> {
    const binding = this.bindings.get(actionId);
    if (!binding || binding.busy) return;
    const version = ++this.navigationVersion;
    const isCurrent = () =>
      isActive() &&
      this.bindings.get(actionId) === binding &&
      this.navigationVersion === version;
    binding.busy = true;
    try {
      if (!binding.settings.workspaceId)
        throw new Error(
          "ワークスペースの取得を待って、ダイヤルで表示対象を選んでください。",
        );
      await this.client.focusWorkspace(binding.settings.workspaceId, isCurrent);
    } catch (error) {
      if (isCurrent()) {
        this.onError(
          actionId,
          error instanceof Error ? error.message : "Orca を表示できません。",
        );
        await binding.key.showAlert();
      }
    } finally {
      binding.busy = false;
    }
  }
}
