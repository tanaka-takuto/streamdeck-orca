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
};

type Binding = {
  key: WorkspaceKey;
  settings: WorkspaceSettings;
  stop?: () => void;
  renderVersion: number;
  lastImage?: string;
  busy: boolean;
};

const styles: Record<
  WorkspaceStatus | "unassigned",
  { color: string; symbol: string; lines: string[] }
> = {
  working: { color: "#145c9e", symbol: "▶", lines: ["進行中"] },
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
  status: WorkspaceStatus | "unassigned",
): string {
  const style = styles[status];
  const title = Array.from(name).slice(0, 12).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" rx="16" fill="${style.color}"/>
<g fill="#fff" font-family="sans-serif" text-anchor="middle">
<text x="72" y="25" font-size="16">${escapeXml(title)}</text>
<text x="72" y="77" font-size="43" font-weight="bold">${style.symbol}</text>
${style.lines.map((line, index) => `<text x="72" y="${style.lines.length === 1 ? 119 : 107 + index * 23}" font-size="21">${line}</text>`).join("")}
</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export class WorkspaceButtons {
  private readonly bindings = new Map<string, Binding>();
  private readonly renders = new Map<string, Promise<void>>();
  private navigationVersion = 0;
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
  }

  private render(binding: Binding, state: MonitorState): void {
    const workspace = state.snapshot?.workspaces.find(
      (row) => row.id === binding.settings.workspaceId,
    );
    const status = binding.settings.workspaceId
      ? getWorkspaceStatus(workspace)
      : state.snapshot
        ? "unassigned"
        : "unknown";
    const image = keyImage(
      workspace?.name ?? binding.settings.workspaceName ?? "Workspace",
      status,
    );
    if (binding.lastImage === image) return;
    const version = ++binding.renderVersion;
    const current = () =>
      this.bindings.get(binding.key.id) === binding &&
      binding.renderVersion === version;
    const previous = this.renders.get(binding.key.id) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (!current()) return;
        await binding.key.setImage(image);
        if (current()) binding.lastImage = image;
      })
      .catch((error: unknown) => {
        if (current())
          this.onError(
            binding.key.id,
            error instanceof Error
              ? error.message
              : "キー表示を更新できません。",
          );
      });
    this.renders.set(binding.key.id, next);
    void next.then(() => {
      if (this.renders.get(binding.key.id) === next)
        this.renders.delete(binding.key.id);
    });
  }

  async press(actionId: string): Promise<void> {
    const binding = this.bindings.get(actionId);
    if (!binding || binding.busy) return;
    const version = ++this.navigationVersion;
    const isCurrent = () =>
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
