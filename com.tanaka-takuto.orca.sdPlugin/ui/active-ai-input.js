const form = document.getElementById("command-form");
const labelInput = document.getElementById("label");
const bodyInput = document.getElementById("body");
const enterInput = document.getElementById("enter");
const save = document.getElementById("save");
const message = document.getElementById("message");
const result = document.getElementById("last-result");
let socket, inspectorId, actionId, actionUuid;
let settings = {};
let dirty = false;
let pendingRevision, saveTimer, pollTimer, requestId;
const controls = [labelInput, bodyInput, enterInput, save];
function showMessage(text) {
  message.textContent = text;
}
function hydrate() {
  labelInput.value = settings.label ?? "";
  bodyInput.value = settings.body ?? "";
  enterInput.checked = settings.enter === true;
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
  pollTimer = setTimeout(requestResult, 2_000);
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
    revision,
  };
  if (!send("setSettings", next)) {
    showMessage("Stream Deck との接続を確認してください。");
    return;
  }
  settings = next;
  pendingRevision = revision;
  dirty = false;
  clearTimeout(saveTimer);
  clearTimeout(pollTimer);
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
      event.payload.requestId === requestId
    ) {
      result.textContent = event.payload.busy
        ? "入力の受付を待っています…"
        : (event.payload.result?.message ?? "まだ入力していません。");
      result.dataset.error = String(
        ["unknown", "refused"].includes(event.payload.result?.status),
      );
    }
  });
  socket.addEventListener("close", () => {
    clearTimeout(saveTimer);
    clearTimeout(pollTimer);
    for (const element of controls) element.disabled = true;
    showMessage(
      "Stream Deck との接続が切れました。入力は保持しています。アクションを選び直してください。",
    );
  });
  socket.addEventListener("error", () =>
    showMessage("Stream Deck に接続できません。"),
  );
};
