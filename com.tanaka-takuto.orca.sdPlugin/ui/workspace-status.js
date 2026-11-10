const byId = (id) => document.getElementById(id);
const name = byId("workspace-name");
const identity = byId("workspace-identity");
const status = byId("workspace-status");
const links = byId("references");
const linkStatus = byId("link-status");
const linkResult = byId("link-result");
const refresh = byId("refresh");
const message = byId("message");
let socket;
let inspectorId;
let actionId;
let actionUuid;
let requestId;
let timer;
let poll;
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
function clearLinks(text) {
  links.replaceChildren();
  linkResult.textContent = "";
  linkStatus.textContent = text;
}
function request() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  clearTimeout(timer);
  clearTimeout(poll);
  requestId = `${Date.now()}-${Math.random()}`;
  refresh.disabled = true;
  socket.send(
    JSON.stringify({
      event: "sendToPlugin",
      context: inspectorId,
      action: actionUuid,
      payload: { type: "get-workspace-button", requestId },
    }),
  );
  timer = setTimeout(() => {
    requestId = undefined;
    refresh.disabled = false;
    status.textContent = "状態不明";
    clearLinks("取得失敗：関連先を確認できません。");
    show("応答を確認できません。状態を更新して確認してください。", true);
  }, 8000);
}
refresh.addEventListener("click", request);
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
    request();
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.event === "didReceiveSettings") {
      clearLinks("関連先を更新しています…");
      identity.textContent = "割当を確認しています…";
      request();
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
    requestId = undefined;
    refresh.disabled = false;
    name.textContent = p.workspaceName;
    const i = p.workspaceIdentity;
    identity.textContent = i
      ? `プロジェクト: ${i.projectLabel ?? i.project ?? "未取得"}\nパス: ${i.path ?? "未取得"}\nID: ${i.id}${i.ambiguous ? "（表示重複・要照合）" : ""}`
      : "長押しで登録";
    status.textContent = labels[p.status] ?? "状態不明";
    links.replaceChildren();
    for (const ref of p.references ?? []) {
      const item = document.createElement("li");
      item.textContent = `${ref.label}\n${ref.url}`;
      links.append(item);
    }
    linkStatus.textContent =
      p.linkError ||
      (p.references?.length
        ? `関連先 ${p.references.length}件`
        : p.workspace
          ? "関連先を取得できません。"
          : "WSを長押し登録すると関連先を確認できます。");
    const r = p.linkResult;
    linkResult.textContent =
      r && r.workspaceId === p.workspace?.workspaceId
        ? [
            `${r.workspaceName} の関連先`,
            r.inProgress
              ? `起動要求中: ${r.requested.length + r.unconfirmed.length} / ${r.total}件`
              : "",
            r.cancelled ? "操作中止（送信済みの要求は取り消していません）" : "",
            `要求済み: ${r.requested.length}件`,
            ...r.requested,
            `結果不明: ${r.unconfirmed.length}件`,
            ...r.unconfirmed.map((item) => `${item.url}\n${item.reason}`),
            `未送信（中止）: ${r.notRequested.length}件`,
            ...r.notRequested,
            "ブラウザーでの表示は確認してください。結果不明のURLは自動再送しません。",
          ]
            .filter(Boolean)
            .join("\n")
        : "起動要求の記録はありません。";
    show(
      p.error || p.notice || "このボタンの割当は長押しで変更できます。",
      Boolean(p.error),
    );
    poll = setTimeout(request, 2000);
  });
  socket.addEventListener("close", () => {
    clearTimeout(timer);
    clearTimeout(poll);
    requestId = undefined;
    refresh.disabled = true;
    status.textContent = "状態不明";
    identity.textContent = "接続切断・対象情報は未確認";
    clearLinks("接続切断・関連先は未確認");
    show(
      "Stream Deck との接続が切れました。アクションを選び直してください。",
      true,
    );
  });
  socket.addEventListener("error", () =>
    show("Stream Deck に接続できません。", true),
  );
};
