const controlInput = document.getElementById("control-id");
const apply = document.getElementById("apply");
const message = document.getElementById("message");
const workspaceName = document.getElementById("workspace-name");
const workspaceStatus = document.getElementById("workspace-status");
const refresh = document.getElementById("refresh");
let socket;
let inspectorId;
let actionId;
let actionUuid;
let settings = {};
let requestId;
let requestTimer;
let pollTimer;
let pendingControlId;
const normalize = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : "main";

function showMessage(text, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
}

function send(event, payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(
    JSON.stringify({
      event,
      context: inspectorId,
      ...(event === "sendToPlugin" ? { action: actionUuid } : {}),
      payload,
    }),
  );
  return true;
}

function requestView() {
  if (pendingControlId !== undefined) return;
  const nextId = `${Date.now()}-${Math.random()}`;
  if (!send("sendToPlugin", { type: "get-control", requestId: nextId })) return;
  requestId = nextId;
  refresh.disabled = true;
  clearTimeout(requestTimer);
  clearTimeout(pollTimer);
  requestTimer = setTimeout(() => {
    refresh.disabled = false;
    workspaceStatus.textContent = "状態不明";
    showMessage(
      "応答を確認できません。Orca の起動状態を確認して、状態を更新してください。",
      true,
    );
  }, 8_000);
}

document.getElementById("control-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const controlId = normalize(controlInput.value);
  const next = { ...settings, controlId };
  if (!send("setSettings", next)) {
    showMessage("Stream Deck との接続を確認してください。", true);
    return;
  }
  settings = next;
  pendingControlId = controlId;
  controlInput.value = controlId;
  clearTimeout(pollTimer);
  clearTimeout(requestTimer);
  requestId = undefined;
  workspaceName.textContent = "設定を保存しています…";
  workspaceStatus.textContent = "";
  showMessage("設定を保存しています…");
  requestTimer = setTimeout(() => {
    showMessage(
      "設定の保存を確認できません。アクションを選び直して確認してください。",
      true,
    );
  }, 8_000);
});
refresh.addEventListener("click", requestView);

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
  settings = action.payload.settings ?? {};
  controlInput.value = normalize(settings.controlId);
  const dial = actionUuid.endsWith(".workspace-dial");
  document.getElementById("heading").textContent = dial
    ? "ダイヤルで表示対象を選ぶ"
    : "ボタンで状態を見て開く";
  document.getElementById("description").textContent = dial
    ? "同じ操作 ID のボタンに表示するワークスペースを、回転で切り替えます。新しいワークスペースも自動で候補に入ります。"
    : "ダイヤルと同じ操作 ID を設定してください。回転で表示対象を選び、このボタンを押すと Orca を開きます。";
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ event: registerEvent, uuid }));
    controlInput.disabled = false;
    apply.disabled = false;
    refresh.disabled = false;
    requestView();
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.event === "didReceiveSettings") {
      const received = event.payload.settings ?? {};
      if (
        pendingControlId !== undefined &&
        normalize(received.controlId) !== pendingControlId
      )
        return;
      pendingControlId = undefined;
      settings = received;
      controlInput.value = normalize(settings.controlId);
      requestView();
      return;
    }
    if (
      event.event !== "sendToPropertyInspector" ||
      event.payload.actionId !== actionId
    )
      return;
    const payload = event.payload;
    if (payload.type === "error") {
      showMessage(payload.message, true);
      return;
    }
    if (
      payload.type !== "control-view" ||
      payload.requestId !== requestId ||
      payload.controlId !== normalize(settings.controlId)
    )
      return;
    clearTimeout(requestTimer);
    refresh.disabled = false;
    workspaceName.textContent = payload.workspaceName;
    workspaceStatus.textContent = `${payload.status} · 候補 ${payload.available} 件`;
    showMessage(
      payload.error ||
        "ダイヤルを回すと選択が変わります。設定画面を開き直す必要はありません。",
      Boolean(payload.error),
    );
    pollTimer = setTimeout(requestView, 2_000);
  });
  socket.addEventListener("close", () => {
    clearTimeout(requestTimer);
    clearTimeout(pollTimer);
    refresh.disabled = true;
    controlInput.disabled = true;
    apply.disabled = true;
    workspaceStatus.textContent = "状態不明";
    showMessage(
      "Stream Deck との接続が切れました。アクションを選び直してください。",
      true,
    );
  });
  socket.addEventListener("error", () =>
    showMessage("Stream Deck に接続できません。", true),
  );
};
