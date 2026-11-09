const byId = (id) => document.getElementById(id);
const name = byId("workspace-name");
const identity = byId("workspace-identity");
const status = byId("workspace-status");
const links = byId("reference");
const linkStatus = byId("link-status");
const save = byId("save-reference");
const refresh = byId("refresh");
const message = byId("message");
let socket;
let inspectorId;
let actionId;
let actionUuid;
let requestId;
let timer;
let poll;
let view;
let saving = false;
let baselineChoice = "";
const labels = {
  working: "進行中",
  waiting: "入力待ち",
  review: "返答あり・要確認",
  idle: "待機",
  unknown: "状態不明",
  unassigned: "未割当",
};
function show(text, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
}
function request(type = "get-workspace-button", extra = {}) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  clearTimeout(timer);
  clearTimeout(poll);
  requestId = `${Date.now()}-${Math.random()}`;
  refresh.disabled = true;
  save.disabled = true;
  links.disabled = true;
  socket.send(
    JSON.stringify({
      event: "sendToPlugin",
      context: inspectorId,
      action: actionUuid,
      payload: { type, requestId, ...extra },
    }),
  );
  timer = setTimeout(() => {
    requestId = undefined;
    saving = false;
    view = undefined;
    refresh.disabled = false;
    status.textContent = "状態不明";
    linkStatus.textContent = "取得失敗：関連先を確認できません。";
    show("応答を確認できません。状態を更新して確認してください。", true);
  }, 8000);
}
refresh.addEventListener("click", () => request());
links.addEventListener("change", () => {
  save.disabled = saving || !view || !links.value;
});
save.addEventListener("click", () => {
  if (!view?.workspace || !links.value || saving) return;
  saving = true;
  show("関連先を保存しています…");
  request("select-reference", {
    workspaceId: view.workspace.workspaceId,
    key: links.value,
    revision: view.revision,
  });
});
window.connectElgatoStreamDeckSocket = (
  port,
  uuid,
  registerEvent,
  _info,
  actionInfo,
) => {
  const action = JSON.parse(actionInfo);
  inspectorId = uuid;
  actionId = action.context;
  actionUuid = action.action;
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ event: registerEvent, uuid }));
    refresh.disabled = false;
    request();
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.event === "didReceiveSettings") {
      if (!saving) request();
      return;
    }
    const p = event.payload;
    if (event.event !== "sendToPropertyInspector" || p?.actionId !== actionId)
      return;
    if (p.type === "error") {
      show(p.message, true);
      return;
    }
    if (
      p.type !== "workspace-button-view" ||
      !requestId ||
      p.requestId !== requestId
    )
      return;
    clearTimeout(timer);
    saving = false;
    refresh.disabled = false;
    const previous = view?.revision === p.revision ? links.value : "";
    view = p;
    name.textContent = p.workspaceName;
    const i = p.workspaceIdentity;
    identity.textContent = i
      ? `プロジェクト: ${i.projectLabel ?? i.project ?? "未取得"}\nパス: ${i.path ?? "未取得"}\nID: ${i.id}\n短タグ: ${i.tag}${i.ambiguous ? "（表示重複・要照合）" : ""}`
      : "長押しで登録";
    status.textContent = labels[p.status] ?? "状態不明";
    links.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "関連先を選択";
    links.append(placeholder);
    for (const ref of p.candidates ?? []) {
      const o = document.createElement("option");
      o.value = ref.key;
      o.textContent = ref.label;
      links.append(o);
    }
    baselineChoice = p.chosen?.key ?? "";
    links.value = (p.candidates ?? []).some((r) => r.key === previous)
      ? previous
      : (p.chosen?.key ?? "");
    links.disabled = !p.ready || !p.candidates?.length;
    save.disabled =
      links.disabled ||
      !links.value ||
      links.value === p.settings?.reference?.key;
    linkStatus.textContent =
      p.linkError ||
      (p.chosen
        ? `${p.chosen.label}\n${p.chosen.url}`
        : p.workspace
          ? "関連先を取得できません。"
          : "WSを長押し登録すると関連先を確認できます。");
    show(
      p.error || p.notice || "このボタンの割当は長押しで変更できます。",
      Boolean(p.error),
    );
    // Preserve an uncommitted choice; polling must not silently save or replace it.
    poll = setTimeout(() => {
      if (!saving && (links.value === baselineChoice || !links.value))
        request();
    }, 2000);
  });
  socket.addEventListener("close", () => {
    clearTimeout(timer);
    clearTimeout(poll);
    requestId = undefined;
    view = undefined;
    refresh.disabled = true;
    links.disabled = true;
    save.disabled = true;
    status.textContent = "状態不明";
    identity.textContent = "接続切断・対象情報は未確認";
    linkStatus.textContent = "接続切断・関連先は未確認";
    links.replaceChildren();
    show(
      "Stream Deck との接続が切れました。アクションを選び直してください。",
      true,
    );
  });
  socket.addEventListener("error", () =>
    show("Stream Deck に接続できません。", true),
  );
};
