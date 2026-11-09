import { settleDisplay } from "./display-wait";
import { shorten, svgText, twoLines } from "./key-text";
import type { OrcaClient } from "./orca/client";
import { getWorkspaceStatus, type WorkspaceStatus } from "./orca/model";
import type { MonitorState, WorkspaceMonitor } from "./orca/monitor";
import {
  ambiguousMessage,
  identityLine,
  type KeyContext,
  workspaceIdentity,
} from "./workspace-identity";

export type WorkspaceSettings = {
  workspaceId?: string;
  workspaceName?: string;
  controlId?: string;
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
  display?: { name: string; status: DisplayStatus; context: KeyContext };
  busy: boolean;
  displayed: boolean;
  feedback?: string;
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
  unassigned: { color: "#30343b", symbol: "−", lines: ["未割当"] },
};

export function keyImage(
  name: string,
  status: DisplayStatus,
  frame = 0,
  context?: KeyContext,
  feedback?: string,
): string {
  const style = styles[status];
  const [first, second] = twoLines(name);
  const hint =
    feedback ||
    (context?.ambiguous
      ? "表示重複・要照合"
      : status === "review"
        ? "要確認・開く"
        : status === "unassigned"
          ? "長押しで登録"
          : "短押しで移動");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" rx="16" fill="${style.color}"/>
<g fill="#fff" font-family="-apple-system, sans-serif" text-anchor="middle">
${context?.controlId ? svgText(`ID ${shorten(context.controlId, 11)} · 開く`, 19, 12) : ""}
${svgText(identityLine(context), context?.controlId ? 35 : 25, 12)}
${svgText(first, 54, context?.controlId ? 16 : 18)}${svgText(second, 77, context?.controlId ? 16 : 18)}
${
  status === "working"
    ? `<g fill="none" stroke="#fff" stroke-width="3"><circle cx="22" cy="100" r="8" opacity="0.25"/><path d="M22 92 A8 8 0 0 1 30 100" stroke-linecap="round" transform="rotate(${(frame % 12) * 30} 22 100)"/></g>`
    : svgText(style.symbol, 108, 23, 22)
}
${svgText(style.lines[0], 107, 18, 83)}
${svgText(hint, 132, 14)}
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
      displayed: false,
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
      : "unassigned";
    binding.display = {
      name: workspace?.name ?? binding.settings.workspaceName ?? "未割当",
      status,
      context: {
        ...workspaceIdentity(
          binding.settings.workspaceId,
          workspace,
          state.snapshot?.workspaces,
        ),
        controlId: binding.settings.controlId,
      },
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
      binding.display.context,
      binding.feedback,
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
        if (this.bindings.get(binding.key.id) === binding)
          binding.displayed = true;
      })
      .catch((error: unknown) => {
        if (current()) {
          binding.desiredImage = undefined;
          binding.displayed = false;
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

  feedback(actionId: string, message?: string): void {
    const binding = this.bindings.get(actionId);
    if (!binding) return;
    binding.feedback = message;
    void this.draw(binding);
  }

  assertReady(actionId: string): void {
    const binding = this.bindings.get(actionId);
    if (!binding?.displayed)
      throw new Error(
        "キーの表示を更新しています。表示後にもう一度押してください。",
      );
    if (!binding.settings.workspaceId)
      throw new Error("未割当：Orca でWSを選び、長押しで登録してください。");
    if (binding.display?.context.ambiguous) throw new Error(ambiguousMessage);
  }

  async waitForDisplay(
    actionId: string,
    isActive = () => true,
    timeoutMs = 2_000,
  ): Promise<boolean> {
    if (timeoutMs <= 0) return false;
    const deadline = Date.now() + timeoutMs;
    while (isActive()) {
      const binding = this.bindings.get(actionId);
      if (!binding) return false;
      if (binding.displayed) return true;
      const pending = this.renders.get(actionId);
      if (!pending || !(await settleDisplay(pending, deadline - Date.now())))
        return false;
    }
    return false;
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
      if (!binding.displayed)
        throw new Error(
          "キーの表示を更新しています。表示を確認して、もう一度押してください。",
        );
      if (!binding.settings.workspaceId)
        throw new Error(
          "ワークスペースの取得を待って、ダイヤルで表示対象を選んでください。",
        );
      if (binding.display?.context.ambiguous) throw new Error(ambiguousMessage);
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
