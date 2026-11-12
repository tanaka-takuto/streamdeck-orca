import { settleDisplay } from "./display-wait";
import {
  type KeyIcon,
  keyColors,
  keyFrame,
  keyHeader,
  keyIcon,
  keyName,
  keyProjectText,
  keyStatus,
  keyText,
} from "./key-layout";
import { shorten } from "./key-text";
import type { OrcaClient } from "./orca/client";
import {
  getWorkspaceStatus,
  type OrcaSnapshot,
  type WorkspaceStatus,
} from "./orca/model";
import type { MonitorState, WorkspaceMonitor } from "./orca/monitor";
import type { WorkspaceReferences } from "./orca/workspace-references";
import {
  ambiguousMessage,
  type KeyContext,
  workspaceIdentity,
} from "./workspace-identity";

export type WorkspaceSettings = {
  workspaceId?: string;
  workspaceName?: string;
  controlId?: string;
  instanceId?: string;
  hostId?: string;
};
export type WorkspaceKey = {
  id: string;
  setImage(image: string): Promise<void>;
  showAlert(): Promise<void>;
  showOk?(): Promise<void>;
};

type DisplayStatus = WorkspaceStatus | "unassigned";
type ReferenceIndicators = { issue: boolean; pr: boolean };
type ReferenceStatus = "unknown" | "loading" | "ready" | "error";
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
  references?: ReferenceIndicators;
  referenceIdentity?: string;
  referenceVersion: number;
  referenceStatus: ReferenceStatus;
  referenceRequest?: Promise<WorkspaceReferences>;
  referenceTimer?: ReturnType<typeof setTimeout>;
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
  割当を解除中: ["解除中", "spinner"],
  移動中: ["移動中", "spinner"],
  関連先を取得中: ["関連取得", "spinner"],
  関連先を送信中: ["要求中", "spinner"],
  関連先を開いた: ["リンク", "link"],
  リンク結果不明: ["結果不明", "question"],
  リンク送信中止: ["中止", "pause"],
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

function referenceIndicators(
  references: ReferenceIndicators | undefined,
  status: ReferenceStatus,
): string {
  const marker = { unknown: "?", loading: "↻", ready: "", error: "!" }[status];
  const label = {
    unknown: "関連先は未確認",
    loading: "関連先を取得中",
    ready: "関連先を確認済み",
    error: "関連先の取得失敗",
  }[status];
  return `<g data-reference-status="${status}"><title>${label}</title>${
    (["issue", "pr"] as const)
      .map((type, index) => {
        const state = references
          ? references[type]
            ? "linked"
            : "unlinked"
          : "unknown";
        return `<g data-reference="${type}" data-reference-state="${state}" opacity="${state === "linked" ? 1 : 0.3}"><title>${type === "issue" ? "Issue" : "PR"}: ${status === "loading" && references ? "前回は" : ""}${state === "unknown" ? "未確認" : state === "linked" ? "関連あり" : "関連なし"}</title>${keyIcon(type, 44 + index * 34, 93, 22, undefined, 3)}</g>`;
      })
      .join("") + keyText(marker, 118, 112, 20, true)
  }</g>`;
}

export function keyImage(
  name: string,
  status: DisplayStatus,
  frame = 0,
  context?: KeyContext,
  feedback?: string,
  references?: ReferenceIndicators,
  referenceStatus: ReferenceStatus = references ? "ready" : "unknown",
): string {
  const style = styles[status];
  const [label, icon] = context?.ambiguous
    ? ["要照合", "warning" as const]
    : feedback
      ? (feedbackLabels[feedback] ?? [shorten(feedback, 8), "warning" as const])
      : [style.label, style.icon];
  const color =
    context?.ambiguous ||
    (feedback && /失敗|不明|消失|変更|中止/u.test(feedback))
      ? keyColors.error
      : style.color;
  return keyFrame(
    color,
    keyHeader(
      keyProjectText(context?.project),
      status === "unassigned" ? "plus" : "folder",
    ) +
      (status === "unassigned"
        ? keyName("未割当")
        : keyName(name, 28, 56, 85) +
          referenceIndicators(references, referenceStatus)) +
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
  private readonly referenceRequests = new WeakMap<
    OrcaSnapshot,
    Map<string, Promise<WorkspaceReferences>>
  >();
  private readonly pendingReferences = new Map<
    string,
    Promise<WorkspaceReferences>
  >();
  constructor(
    private readonly monitor: WorkspaceMonitor,
    private readonly client: Pick<OrcaClient, "focusWorkspace" | "references">,
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
      referenceVersion: 0,
      referenceStatus: "unknown",
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
    clearTimeout(binding?.referenceTimer);
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
    this.refreshReferences(binding, state);
    void this.draw(binding);
    this.updateAnimation();
  }

  private refreshReferences(binding: Binding, state: MonitorState): void {
    const version = ++binding.referenceVersion;
    const snapshot = state.snapshot;
    const rows = snapshot?.workspaces.filter(
      (row) => row.id === binding.settings.workspaceId,
    );
    const workspace = rows?.length === 1 ? rows[0] : undefined;
    if (
      !snapshot ||
      state.error ||
      state.fromCache ||
      snapshot.truncated !== false ||
      snapshot.omittedHosts !== false ||
      !workspace ||
      !snapshot.hostIds?.includes(workspace.hostId) ||
      (binding.settings.instanceId &&
        binding.settings.instanceId !== workspace.instanceId) ||
      (binding.settings.hostId && binding.settings.hostId !== workspace.hostId)
    ) {
      binding.referenceIdentity = undefined;
      binding.references = undefined;
      binding.referenceStatus = state.error ? "error" : "unknown";
      binding.referenceRequest = undefined;
      clearTimeout(binding.referenceTimer);
      return;
    }
    const identity = JSON.stringify([
      snapshot.runtimeId,
      workspace.id,
      workspace.instanceId,
      workspace.hostId,
    ]);
    if (binding.referenceIdentity !== identity) {
      binding.references = undefined;
      binding.referenceStatus = "unknown";
      binding.referenceRequest = undefined;
      clearTimeout(binding.referenceTimer);
    }
    binding.referenceIdentity = identity;
    // 同じ一覧・WSを表示する複数キーは一度の読取を共有する。
    let requests = this.referenceRequests.get(snapshot);
    if (!requests) {
      requests = new Map();
      this.referenceRequests.set(snapshot, requests);
    }
    let request = requests.get(identity);
    if (!request) {
      request = this.pendingReferences.get(identity);
      if (!request) {
        request = Promise.resolve().then(() =>
          this.client.references(workspace.id, snapshot.runtimeId),
        );
        this.pendingReferences.set(identity, request);
        const cleanup = () => this.pendingReferences.delete(identity);
        void request.then(cleanup, cleanup);
      }
      requests.set(identity, request);
    }
    if (binding.referenceRequest !== request) {
      binding.referenceRequest = request;
      clearTimeout(binding.referenceTimer);
      if (binding.referenceStatus === "unknown") {
        binding.referenceStatus = "loading";
      } else if (binding.referenceStatus !== "loading") {
        // 速い定期更新は点滅させず、長引いた読取だけ前回値に更新印を添える。
        const pending = request;
        binding.referenceTimer = setTimeout(() => {
          if (
            this.bindings.get(binding.key.id) !== binding ||
            binding.referenceRequest !== pending
          )
            return;
          binding.referenceStatus = "loading";
          void this.draw(binding);
        }, 300);
        binding.referenceTimer.unref?.();
      }
    }
    const current = () =>
      this.bindings.get(binding.key.id) === binding &&
      binding.referenceVersion === version;
    void request
      .then((data) => {
        if (!current()) return;
        if (
          data.workspaceId !== workspace.id ||
          (workspace.instanceId && data.instanceId !== workspace.instanceId) ||
          data.hostId !== workspace.hostId
        )
          throw new Error("関連先の対象を確認できません。");
        binding.references = {
          issue: data.references.some((ref) => ref.type === "issue"),
          pr: data.references.some((ref) => ref.type === "pr"),
        };
        clearTimeout(binding.referenceTimer);
        binding.referenceStatus = "ready";
        void this.draw(binding);
      })
      .catch(() => {
        if (!current()) return;
        // 読取失敗は「関連なし」や「未確認」と区別し、次回の定期更新で再確認する。
        clearTimeout(binding.referenceTimer);
        binding.references = undefined;
        binding.referenceStatus = "error";
        void this.draw(binding);
      });
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
      binding.references,
      binding.referenceStatus,
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
