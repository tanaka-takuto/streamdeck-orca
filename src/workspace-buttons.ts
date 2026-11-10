import { settleDisplay } from "./display-wait";
import {
  type KeyIcon,
  keyColors,
  keyFrame,
  keyHeader,
  keyName,
  keyProjectText,
  keyStatus,
} from "./key-layout";
import { shorten } from "./key-text";
import type { OrcaClient } from "./orca/client";
import { getWorkspaceStatus, type WorkspaceStatus } from "./orca/model";
import type { MonitorState, WorkspaceMonitor } from "./orca/monitor";
import {
  ambiguousMessage,
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
  { color: string; icon: KeyIcon; label: string }
> = {
  working: { color: keyColors.working, icon: "spinner", label: "進行中" },
  waiting: { color: keyColors.waiting, icon: "waiting", label: "入力待ち" },
  review: { color: keyColors.review, icon: "reply", label: "返答あり" },
  idle: { color: keyColors.idle, icon: "pause", label: "待機" },
  unknown: { color: keyColors.unknown, icon: "question", label: "状態不明" },
  unassigned: { color: keyColors.idle, icon: "plus", label: "未割当" },
};
const feedbackLabels: Record<string, [string, KeyIcon]> = {
  登録まで長押し: ["登録待ち", "spinner"],
  移動待ち: ["判定待ち", "pause"],
  選択WSを取得中: ["WS取得中", "spinner"],
  登録を保存中: ["保存中", "spinner"],
  登録完了: ["登録済", "check"],
  移動中: ["移動中", "spinner"],
  関連先を取得中: ["関連取得", "spinner"],
  関連先を開いた: ["リンク", "link"],
  関連先を保存: ["保存済", "link"],
  長押しで登録: ["未割当", "plus"],
  保存結果不明: ["保存不明", "question"],
  関連先なし: ["リンク無", "link"],
  選択先消失: ["消失", "warning"],
  関連先が複数: ["複数", "link"],
  取得失敗: ["取得失敗", "warning"],
  登録失敗: ["登録失敗", "warning"],
  "環境変更・再操作": ["環境変更", "warning"],
};

export function keyImage(
  name: string,
  status: DisplayStatus,
  frame = 0,
  context?: KeyContext,
  feedback?: string,
): string {
  const style = styles[status];
  const [label, icon] = context?.ambiguous
    ? ["要照合", "warning" as const]
    : feedback
      ? (feedbackLabels[feedback] ?? [shorten(feedback, 8), "warning" as const])
      : [style.label, style.icon];
  const color =
    context?.ambiguous || (feedback && /失敗|不明|消失|変更/u.test(feedback))
      ? keyColors.error
      : style.color;
  return keyFrame(
    color,
    keyHeader(
      keyProjectText(context?.project),
      status === "unassigned" ? "plus" : "folder",
    ) +
      keyName(status === "unassigned" ? "未割当" : name) +
      (status === "unassigned" && !feedback
        ? ""
        : keyStatus(label, icon, icon === "spinner" ? frame : undefined)),
  );
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
        throw new Error("Orca でWSを選び、長押しで登録してください。");
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
