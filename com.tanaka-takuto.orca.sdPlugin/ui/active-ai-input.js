const form = document.getElementById("command-form");
const labelInput = document.getElementById("label");
const bodyInput = document.getElementById("body");
const enterInput = document.getElementById("enter");
const modeInput = document.getElementById("recipient-mode");
const recipient = document.getElementById("recipient");
const recipientDetails = document.getElementById("recipient-details");
const save = document.getElementById("save");
const message = document.getElementById("message");
const result = document.getElementById("last-result");
let socket, inspectorId, actionId, actionUuid;
let settings = {};
let dirty = false;
let pendingRevision, saveTimer, pollTimer, viewTimer, requestId;
const controls = [labelInput, bodyInput, enterInput, modeInput, save];
function showMessage(text) {
  message.textContent = text;
}
function hydrate() {
  labelInput.value = settings.label ?? "";
  bodyInput.value = settings.body ?? "";
  enterInput.checked = settings.enter === true;
  modeInput.checked = settings.recipientMode === "displayed-v1";
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
function requestResult() {
  if (pendingRevision) return;
  clearTimeout(pollTimer);
  requestId = `${Date.now()}-${Math.random()}`;
  send("sendToPlugin", { type: "get-active-input-result", requestId });
  clearTimeout(viewTimer);
  const expected = requestId;
  viewTimer = setTimeout(() => {
    if (requestId !== expected) return;
    requestId = undefined;
    recipient.textContent =
      "表示先の取得を確認できません。キーの更新を確認してください。";
    recipientDetails.textContent = "";
    pollTimer = setTimeout(requestResult, 2000);
  }, 5000);
}
form.addEventListener("input", () => {
  dirty = true;
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const revision = `${Date.now()}-${Math.random()}`;
  const next = {
    ...settings,
    label: labelInput.value,
    body: bodyInput.value,
    enter: enterInput.checked,
    recipientMode: modeInput.checked ? "displayed-v1" : undefined,
    revision,
  };
  if (!send("setSettings", next)) {
    showMessage("Stream Deck との接続を確認してください。");
    return;
  }
  settings = next;
  pendingRevision = revision;
  requestId = undefined;
  recipient.textContent = "保存中です。表示先を再取得します。";
  recipientDetails.textContent = "";
  dirty = false;
  clearTimeout(saveTimer);
  clearTimeout(pollTimer);
  clearTimeout(viewTimer);
  showMessage("設定を保存しています…");
  saveTimer = setTimeout(() => {
    pendingRevision = undefined;
    showMessage(
      "保存を確認できません。入力は保持しています。アクションを選び直して確認してください。",
    );
  }, 8_000);
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
  settings = action.payload.settings ?? {};
  hydrate();
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ event: registerEvent, uuid }));
    for (const element of controls) element.disabled = false;
    showMessage("設定を保存したら、実機のキーを押して入力してください。");
    requestResult();
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.event === "didReceiveSettings") {
      const received = event.payload.settings ?? {};
      if (pendingRevision && received.revision !== pendingRevision) return;
      pendingRevision = undefined;
      clearTimeout(saveTimer);
      settings = received;
      if (!dirty) hydrate();
      showMessage("設定を保存しました。実機のキーを押して入力してください。");
      requestResult();
    } else if (
      event.event === "sendToPropertyInspector" &&
      event.payload.actionId === actionId &&
      event.payload.type === "active-input-result" &&
      !pendingRevision &&
      event.payload.requestId === requestId
    ) {
      clearTimeout(viewTimer);
      requestId = undefined;
      pollTimer = setTimeout(requestResult, 2000);
      const target = event.payload.recipient;
      recipient.textContent = target
        ? [
            target.workspace.project || "未取得",
            target.workspace.name,
            `${target.target.name} · ${target.target.identity}`,
            `照合用位置（画面と異なる場合あり）: ${target.location}`,
            event.payload.enabled
              ? event.payload.state || "キーの表示先へ入力します"
              : "設定の確認保存まで入力しません",
          ].join("\n")
        : event.payload.state || "表示先を取得できません。";
      recipientDetails.textContent = target
        ? [
            target.workspace.path,
            `WS: ${target.workspace.id}`,
            `Host: ${target.workspace.hostId}`,
            `Runtime: ${target.selection.runtimeId}`,
            `Handle: ${target.target.handle}`,
            `Incarnation: ${target.target.incarnationId}`,
            `Pane: ${target.target.paneKey}`,
          ].join("\n")
        : "";
      const receipt = event.payload.receipt;
      const old = receipt?.recipient;
      result.textContent = receipt
        ? [
            event.payload.busy
              ? "受付確認中（この押下の内容）"
              : "直近の押下（現在の設定とは別の記録）",
            new Date(receipt.at).toLocaleString(),
            "操作: " +
              receipt.label +
              (receipt.enter ? " / 入力＋Enter" : " / 入力のみ"),
            old
              ? [
                  old.workspace.project,
                  old.workspace.name,
                  old.target.name,
                  old.target.identity,
                  old.location,
                  old.workspace.path,
                  `WS: ${old.workspace.id}`,
                  `Handle: ${old.target.handle}`,
                  `Incarnation: ${old.target.incarnationId}`,
                  `Pane: ${old.target.paneKey}`,
                  `Host: ${old.workspace.hostId}`,
                  `Runtime: ${old.selection.runtimeId}`,
                ].join("\n")
              : "押下時の入力先は未取得",
            receipt.result.message,
          ].join("\n")
        : "このプラグイン起動中の記録はありません。過去の未入力を示すものではありません。";
      result.style.whiteSpace = "pre-wrap";
      result.style.overflowWrap = "anywhere";
      result.dataset.error = String(
        ["unknown", "refused"].includes(receipt?.result.status),
      );
    }
  });
  socket.addEventListener("close", () => {
    clearTimeout(saveTimer);
    clearTimeout(pollTimer);
    clearTimeout(viewTimer);
    requestId = undefined;
    recipient.textContent = "接続切れ・表示先を確認できません。";
    recipientDetails.textContent = "";
    for (const element of controls) element.disabled = true;
    showMessage(
      "Stream Deck との接続が切れました。入力は保持しています。アクションを選び直してください。",
    );
  });
  socket.addEventListener("error", () =>
    showMessage("Stream Deck に接続できません。"),
  );
};
