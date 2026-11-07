import type { ChangeRadar, RadarContact, RadarResult } from "./change-radar";
import { shorten, twoLines } from "./key-text";
import type { CliRunner, OrcaClient } from "./orca/client";
import { readResponse } from "./orca/model";
import { workspaceTag } from "./workspace-identity";
import type { ControlView } from "./workspace-selections";
export type RadarContext = {
  view: ControlView;
  catalog: RadarContact["self"]["workspace"][];
  runtimeId?: string;
  unavailable: boolean;
  partial: boolean;
};
type Source = {
  observeControl: (id: string, fn: () => void) => () => void;
  controlContext: (id: string) => RadarContext;
  freshControlContext: (id: string) => Promise<RadarContext>;
  beginNavigation: () => () => boolean;
};
export type RadarDial = {
  id: string;
  setFeedback: (data: Record<string, string>) => Promise<void>;
  showAlert: () => Promise<void>;
};
type Feed = {
  id: string;
  context: RadarContext;
  signature: string;
  generation: number;
  active: boolean;
  listeners: Set<() => void>;
  stop?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  again?: boolean;
  updating: boolean;
  error?: string;
  result?: RadarResult;
};
type Intent = { contact: RadarContact; runtimeId: string };
type Binding = {
  dial: RadarDial;
  controlId: string;
  feed: Feed;
  stop: () => void;
  queue: Promise<void>;
  selectedId?: string;
  desired?: string;
  displayed?: Intent;
  version: number;
  busy: boolean;
  message?: string;
};
export function radarContactFeedback(c: RadarContact) {
  const [file, file2] = twoLines(c.path, 22);
  return {
    pair: `${shorten(c.self.workspace.name, 11)} ↔ ${shorten(c.peer.workspace.name, 11)}`,
    file,
    file2,
    detail: `${workspaceTag(c.self.workspace.id)} ↔ ${workspaceTag(c.peer.workspace.id)} · ${workspaceTag(c.path)}`,
  };
}
const labels = {
  lines: "同じ行域",
  file: "同じファイル",
  same: "内容が同じ",
  structure: "追加・削除",
  manual: "手動で確認",
};
export class RadarController {
  private readonly feeds = new Map<string, Feed>();
  private readonly bindings = new Map<string, Binding>();
  private readonly renders = new Map<string, Promise<void>>();
  private scans: Promise<void> = Promise.resolve();
  constructor(
    private readonly source: Source,
    private readonly scanner: Pick<ChangeRadar, "scan" | "pair">,
    private readonly run: CliRunner,
    private readonly client: Pick<OrcaClient, "focusWorkspace">,
    private readonly interval = 8000,
  ) {}
  private publish(feed: Feed) {
    for (const fn of feed.listeners) fn();
  }
  private contextChanged(feed: Feed) {
    const context = this.source.controlContext(feed.id),
      signature = JSON.stringify([
        context.view.workspaceId,
        context.runtimeId,
        context.unavailable,
        context.partial,
        context.catalog.map((w) => [
          w.id,
          w.path,
          w.hostId,
          w.instanceId,
          w.name,
          w.project,
        ]),
      ]);
    feed.context = context;
    if (signature === feed.signature) return;
    feed.signature = signature;
    feed.generation++;
    feed.result = undefined;
    feed.error = undefined;
    this.publish(feed);
    void this.refresh(feed);
  }
  private refresh(feed: Feed): Promise<void> {
    if (feed.pending) {
      feed.again = true;
      return feed.pending;
    }
    clearTimeout(feed.timer);
    const generation = feed.generation,
      context = feed.context;
    feed.updating = true;
    this.publish(feed);
    const execute = async () => {
      if (!feed.active || feed.generation !== generation) return;
      try {
        if (context.unavailable || !context.view.workspace)
          throw new Error("Orcaの対象を取得できません。");
        const result = await this.scanner.scan(
          context.view.workspace,
          context.catalog,
        );
        if (feed.active && feed.generation === generation) {
          feed.result = result;
          feed.error = undefined;
        }
      } catch (error) {
        if (feed.active && feed.generation === generation) {
          feed.result = undefined;
          feed.error =
            error instanceof Error ? error.message : "変更を取得できません。";
        }
      }
    };
    const pending = this.scans.catch(() => {}).then(execute);
    this.scans = pending;
    feed.pending = pending;
    void pending.finally(() => {
      feed.pending = undefined;
      feed.updating = false;
      if (!feed.active) return;
      if (feed.again || feed.generation !== generation) {
        feed.again = false;
        void this.refresh(feed);
      } else {
        this.publish(feed);
        feed.timer = setTimeout(() => void this.refresh(feed), this.interval);
        feed.timer.unref();
      }
    });
    return pending;
  }
  bind(dial: RadarDial, controlId: string): void {
    this.unbind(dial.id);
    let feed = this.feeds.get(controlId);
    if (!feed) {
      feed = {
        id: controlId,
        context: this.source.controlContext(controlId),
        signature: "",
        generation: 0,
        active: true,
        listeners: new Set(),
        updating: false,
      };
      this.feeds.set(controlId, feed);
    }
    const binding: Binding = {
      dial,
      controlId,
      feed,
      stop: () => {},
      queue: this.renders.get(dial.id) ?? Promise.resolve(),
      version: 0,
      busy: false,
    };
    this.bindings.set(dial.id, binding);
    const listener = () => this.render(binding);
    feed.listeners.add(listener);
    const targetFeed = feed;
    binding.stop = () => targetFeed.listeners.delete(listener);
    if (!feed.stop)
      feed.stop = this.source.observeControl(controlId, () =>
        this.contextChanged(targetFeed),
      );
    this.contextChanged(feed);
    this.render(binding);
  }
  unbind(id: string): void {
    const b = this.bindings.get(id);
    if (!b) return;
    this.bindings.delete(id);
    b.version++;
    b.stop();
    const f = b.feed;
    if (!f.listeners.size) {
      f.active = false;
      f.generation++;
      clearTimeout(f.timer);
      f.stop?.();
      this.feeds.delete(f.id);
    }
  }
  private selected(b: Binding): RadarContact | undefined {
    const rows = b.feed.result?.contacts ?? [];
    return rows.find((c) => c.id === b.selectedId) ?? rows[0];
  }
  private ambiguous(b: Binding, c: RadarContact): boolean {
    const key = (w: RadarContact["self"]["workspace"]) =>
      JSON.stringify([shorten(w.name, 11), workspaceTag(w.id)]);
    if (
      [c.self.workspace, c.peer.workspace].some((w) =>
        b.feed.context.catalog.some(
          (other) => other.id !== w.id && key(other) === key(w),
        ),
      )
    )
      return true;
    const visible = JSON.stringify(radarContactFeedback(c));
    return (b.feed.result?.contacts ?? []).some(
      (other) =>
        other.id !== c.id &&
        JSON.stringify(radarContactFeedback(other)) === visible,
    );
  }
  private render(b: Binding): void {
    if (this.bindings.get(b.dial.id) !== b) return;
    const f = b.feed,
      c = this.selected(b);
    if (c) b.selectedId = c.id;
    const index = c ? (f.result?.contacts.indexOf(c) ?? 0) + 1 : 0,
      total = f.result?.contacts.length ?? 0;
    const [file, file2] = twoLines(
      c?.path ?? (f.context.view.workspaceName || "対象未選択"),
      22,
    );
    const data = {
      title: f.updating
        ? "比較中"
        : f.error
          ? "取得できません"
          : total
            ? `${f.result?.skipped.length || f.context.partial ? "一部・" : ""}${labels[c?.kind ?? "manual"]} ${index}/${total}`
            : f.result?.skipped.length || f.context.partial
              ? "接点0・未比較あり"
              : f.result?.compared === 0
                ? "比較相手なし"
                : "共通ファイルなし",
      pair: c
        ? radarContactFeedback(c).pair
        : shorten(f.context.view.workspaceName, 24),
      file,
      file2,
      detail: c
        ? radarContactFeedback(c).detail
        : f.result
          ? `${f.result.compared}WS比較・対象外${f.result.skipped.length}`
          : "ローカルGitを確認",
      operation: b.busy
        ? "開いています"
        : f.updating
          ? "更新後に操作できます"
          : c
            ? this.ambiguous(b, c)
              ? "表示重複・PIで照合"
              : `押:自${c.self.open === "workspace" ? "WS" : c.self.open === "staged" ? "ステージ" : "コード"} / 触:相${c.peer.open === "workspace" ? "WS" : c.peer.open === "staged" ? "ステージ" : "コード"}`
            : "回転:更新",
    };
    const desired = JSON.stringify([
      data,
      c?.fingerprint,
      f.context.runtimeId,
      b.controlId,
    ]);
    if (b.desired !== desired) {
      b.displayed = undefined;
      b.desired = desired;
    }
    b.queue = b.queue
      .catch(() => {})
      .then(async () => {
        if (this.bindings.get(b.dial.id) !== b || b.desired !== desired) return;
        await b.dial.setFeedback(data);
        if (
          this.bindings.get(b.dial.id) === b &&
          b.desired === desired &&
          !f.updating &&
          !f.error &&
          c &&
          f.context.runtimeId
        )
          b.displayed = { contact: c, runtimeId: f.context.runtimeId };
      });
    const rendering = b.queue;
    this.renders.set(b.dial.id, rendering);
    const cleanup = () => {
      if (this.renders.get(b.dial.id) === rendering)
        this.renders.delete(b.dial.id);
    };
    void rendering.then(cleanup, () => {
      b.displayed = undefined;
      cleanup();
    });
  }
  rotate(id: string, ticks: number): void {
    const b = this.bindings.get(id);
    if (!b || !Number.isFinite(ticks) || !Math.trunc(ticks)) return;
    b.version++;
    b.message = undefined;
    const rows = b.feed.result?.contacts ?? [];
    if (!rows.length) {
      void this.refresh(b.feed);
      return;
    }
    const selected = this.selected(b),
      index = Math.max(
        0,
        rows.findIndex((c) => c.id === selected?.id),
      );
    b.selectedId =
      rows[
        (((index + Math.trunc(ticks)) % rows.length) + rows.length) %
          rows.length
      ].id;
    this.render(b);
  }
  async open(id: string, side: "self" | "peer"): Promise<void> {
    const b = this.bindings.get(id);
    if (!b || b.busy) return;
    const intent = b.displayed;
    if (!intent || b.feed.updating || b.feed.error) {
      b.message = "表示を更新しています。接点を確認して押し直してください。";
      await b.dial.showAlert();
      return;
    }
    if (this.ambiguous(b, intent.contact)) {
      b.message =
        "レーダー上の表示が重複しています。設定画面の完全IDを確認し、Orca側で開いてください。";
      await b.dial.showAlert();
      return;
    }
    const feedGeneration = b.feed.generation,
      feedSignature = b.feed.signature;
    const version = ++b.version,
      navigation = this.source.beginNavigation();
    b.busy = true;
    b.message = undefined;
    this.render(b);
    const current = () =>
      this.bindings.get(id) === b &&
      b.version === version &&
      b.feed.generation === feedGeneration &&
      b.feed.signature === feedSignature &&
      navigation() &&
      this.selected(b)?.fingerprint === intent.contact.fingerprint;
    try {
      const context = await this.source.freshControlContext(b.controlId),
        original = intent.contact;
      if (!current()) return;
      const self = context.catalog.find(
          (w) => w.id === original.self.workspace.id,
        ),
        peer = context.catalog.find((w) => w.id === original.peer.workspace.id);
      if (
        this.ambiguous(b, original) ||
        context.unavailable ||
        context.runtimeId !== intent.runtimeId ||
        context.view.workspaceId !== original.self.workspace.id ||
        !self ||
        !peer ||
        [self, peer].some((w, i) => {
          const old =
            i === 0 ? original.self.workspace : original.peer.workspace;
          return (
            w.hostId !== "local" ||
            w.path !== old.path ||
            w.instanceId !== old.instanceId
          );
        })
      )
        throw new Error(
          "表示したワークスペースが変わりました。表示を確認して押し直してください。",
        );
      const fresh = (await this.scanner.pair(self, peer)).find(
        (c) => c.id === original.id,
      );
      if (!current()) return;
      if (!fresh || fresh.fingerprint !== original.fingerprint)
        throw new Error(
          "表示後に変更内容が変わりました。更新された接点を確認して押し直してください。",
        );
      const target = original[side];
      if (target.open === "workspace") {
        const focused = await this.client.focusWorkspace(
          target.workspace.id,
          current,
        );
        if (!focused || !current()) {
          b.message =
            "表示した側への移動完了を確認できません。Orca側で確認してください。";
          return;
        }
        b.message = `押下時の対象 ${target.workspace.name} [${target.workspace.id}]：直接表示できない比較元のためWSを開きました。`;
      } else {
        if (!current()) return;
        const response = readResponse(
          await this.run([
            "file",
            ...(target.open === "staged" ? ["diff"] : ["open"]),
            `--path=${original.path}`,
            ...(target.open === "staged"
              ? ["--staged"]
              : ["--line", String(target.line)]),
            "--worktree",
            `id:${target.workspace.id}`,
            "--focus",
            "--json",
          ]),
        );
        if (
          response.runtimeId !== intent.runtimeId ||
          response.result.opened !== true
        )
          throw new Error(
            "開いた結果を確認できません。Orca側で確認してください。",
          );
        b.message = `押下時の${side === "self" ? "自分" : "相手"}側 ${target.workspace.name} [${target.workspace.id}]：${original.path}${target.open === "staged" ? " のステージ差分" : `:${target.line}`} を開きました。`;
      }
    } catch (error) {
      b.message =
        error instanceof Error ? error.message : "開いた結果を確認できません。";
      if (this.bindings.get(id) === b) await b.dial.showAlert();
    } finally {
      b.busy = false;
      if (this.bindings.get(id) === b) {
        this.render(b);
        void this.refresh(b.feed);
      }
    }
  }
  view(id: string) {
    const b = this.bindings.get(id);
    if (!b) return { error: "レーダーを表示してから確認してください。" };
    return {
      controlId: b.controlId,
      context: b.feed.context,
      contact: this.selected(b),
      displayed: b.displayed?.contact,
      result: b.feed.result,
      updating: b.feed.updating,
      error: b.feed.error,
      busy: b.busy,
      message: b.message,
    };
  }
}
