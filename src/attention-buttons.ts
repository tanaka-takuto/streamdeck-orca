import {
  type AttentionCandidate,
  AttentionQueue,
  type AttentionTarget,
  attentionTarget,
  matchesAttentionTarget,
} from "./attention";
import { attentionImage, displayName, workspaceTag } from "./attention-image";
import type { OrcaClient } from "./orca/client";
import type { WorkspaceMonitor } from "./orca/monitor";
import type { WorkspaceKey } from "./workspace-buttons";
import {
  ambiguousMessage,
  projectLabel,
  workspaceIdentity,
} from "./workspace-identity";

type Binding = {
  key: WorkspaceKey;
  stop?: () => void;
  version: number;
  image?: string;
  displayed?: AttentionTarget;
};
export class AttentionButtons {
  private readonly queue = new AttentionQueue();
  private readonly bindings = new Map<string, Binding>();
  private readonly renders = new Map<string, Promise<void>>();
  private busy = false;
  private opening?: AttentionCandidate;
  private receivedAt?: number;
  private result?: {
    workspaceName: string;
    project: string;
    status: "opened" | "unconfirmed" | "changed";
    message: string;
  };
  constructor(
    private readonly monitor: WorkspaceMonitor,
    private readonly client: Pick<OrcaClient, "focusWorkspace">,
    private readonly navigation: () => () => boolean,
    private readonly report: (id: string, message: string) => void,
  ) {}
  bind(key: WorkspaceKey): void {
    this.unbind(key.id);
    const binding: Binding = { key, version: 0 };
    this.bindings.set(key.id, binding);
    binding.stop = this.monitor.subscribe((state) => {
      this.queue.update(state);
      if (state.snapshot && !state.fromCache) this.receivedAt = Date.now();
      this.renderAll();
    });
  }
  unbind(id: string): void {
    const b = this.bindings.get(id);
    this.bindings.delete(id);
    b?.stop?.();
  }
  private renderAll(): void {
    const view = this.opening
      ? { ...this.queue.view, current: this.opening }
      : this.queue.view;
    const image = attentionImage(view, this.busy);
    const target = attentionTarget(view);
    const renderKey = JSON.stringify([image, target]);
    for (const binding of this.bindings.values()) {
      if (binding.image === renderKey) continue;
      binding.image = renderKey;
      const version = ++binding.version;
      const current = () =>
        this.bindings.get(binding.key.id) === binding &&
        binding.version === version;
      const previous = this.renders.get(binding.key.id) ?? Promise.resolve();
      const next = previous
        .catch(() => {})
        .then(async () => {
          if (!current()) return;
          // 送信中はどの画像が実際に見えているか未確定。旧対象を使わない。
          binding.displayed = undefined;
          await binding.key.setImage(image);
          // 新しい版に追い越されても、この画像のSDK送信は完了した。
          // 次の送信が始まるまでは、その画像の対象だけを保持する。
          if (this.bindings.get(binding.key.id) === binding)
            binding.displayed = target;
        })
        .catch(() => {
          if (current()) {
            binding.image = undefined;
            binding.displayed = undefined;
            this.report(binding.key.id, "確認先キーの表示を更新できません。");
          }
        });
      this.renders.set(binding.key.id, next);
      void next.then(() => {
        if (this.renders.get(binding.key.id) === next)
          this.renders.delete(binding.key.id);
      });
    }
  }
  async press(id: string): Promise<void> {
    const binding = this.bindings.get(id);
    if (!binding || this.busy) return;
    const target = binding.displayed;
    const navigationCurrent = this.navigation();
    const current = () =>
      this.bindings.get(id) === binding && navigationCurrent();
    this.busy = true;
    this.opening = this.queue.view.candidates.find(
      (c) => c.workspace.id === target?.workspaceId,
    );
    this.renderAll();
    const name = this.opening?.workspace.name ?? "表示対象なし";
    const project = this.opening?.workspace.project ?? "";
    try {
      const state = await this.monitor.refresh();
      if (!current()) return;
      if (!state.snapshot || state.fromCache)
        throw new Error(state.error ?? "最新の状態を取得できません。");
      if (!target) return; // 初回/空表示の押下は再取得のみ。新たに現れた候補は開かない。
      if (
        workspaceIdentity(
          target.workspaceId,
          state.snapshot.workspaces.find((w) => w.id === target.workspaceId),
          state.snapshot.workspaces,
        )?.ambiguous
      )
        throw new Error(ambiguousMessage);
      if (!matchesAttentionTarget(state.snapshot, target)) {
        this.result = {
          workspaceName: name,
          project,
          status: "changed",
          message:
            "表示した対象が変わりました。新しい表示を確認して、もう一度押してください。",
        };
        this.report(id, this.result.message);
        await binding.key.showAlert();
        return;
      }
      const opened = await this.client.focusWorkspace(
        target.workspaceId,
        current,
        target,
      );
      if (opened && current()) {
        this.result = {
          workspaceName: name,
          project,
          status: "opened",
          message:
            "作業場所を開きました。入力先はOrcaで確認してください。既読や承認にはしていません。",
        };
        this.queue.advance(target);
      }
    } catch (error) {
      if (current()) {
        const message =
          error instanceof Error
            ? error.message
            : "移動結果を確認できません。Orcaで表示を確認してください。";
        this.result = {
          workspaceName: name,
          project,
          status: "unconfirmed",
          message,
        };
        this.report(id, message);
        await binding.key.showAlert();
      }
    } finally {
      this.busy = false;
      this.opening = undefined;
      this.renderAll();
    }
  }
  async inspectorView(id: string) {
    const binding = this.bindings.get(id);
    if (!binding) return;
    await this.monitor.refresh();
    if (this.bindings.get(id) !== binding) return;
    const v = this.queue.view;
    const w = v.current?.workspace;
    return {
      coverage: v.coverage,
      fromCache: v.fromCache,
      error: v.error,
      counts: v.counts,
      receivedAt: this.receivedAt,
      busy: this.busy,
      result: this.result,
      current: w
        ? {
            name: w.name,
            id: w.id,
            project: w.project,
            projectLabel: projectLabel(w.project),
            path: w.path,
            displayName: displayName(v),
            tag: workspaceTag(w.id),
            ambiguous: v.current?.identity?.ambiguous ?? false,
            kind: v.current?.kind,
            working: w.agents.some((a) => a.state === "working"),
          }
        : undefined,
    };
  }
}
