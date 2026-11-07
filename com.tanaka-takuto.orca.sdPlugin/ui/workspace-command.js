const form = document.getElementById("command-form");
const controlInput = document.getElementById("control-id");
const modeInput = document.getElementById("mode");
const labelInput = document.getElementById("label");
const bodyInput = document.getElementById("body");
const closeOnExitInput = document.getElementById("close-on-exit");
const closeOnSuccessInput = document.getElementById("close-on-success");
const agentSelect = document.getElementById("agent-target");
const save = document.getElementById("save");
const refresh = document.getElementById("refresh");
const message = document.getElementById("message");
const lastResult = document.getElementById("last-result");
const normalize = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : "main";
const draftTargets = new Map();
let socket;
let inspectorId;
let actionId;
let actionUuid;
let settings = {};
let view;
let dirty = false;
let pendingRevision;
let requestId;
let requestTimer;
let saveTimer;
let pollTimer;

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
function updateMode() {
  const ai = modeInput.value === "ai";
  document.getElementById("agent-panel").hidden = !ai;
  document.getElementById("shell-options").hidden = ai;
  document.getElementById("body-label").textContent = ai
    ? "AIへ送る指示"
    : "実行するコマンド";
  bodyInput.placeholder = ai ? "例: 今回の変更をレビューして" : "例: npm test";
  document.getElementById("mode-help").textContent = ai
    ? "Orca が認識するターミナル上の AI が対象です。複数いる場合は送信先を選んでください。"
    : "コマンドごとに新しい実行用ターミナルを開きます。自動クローズは macOS / Linux の sh と $SHELL を使用します。";
  const changedId =
    normalize(controlInput.value) !== normalize(settings.controlId);
  agentSelect.disabled =
    socket?.readyState !== WebSocket.OPEN || !view?.workspaceId || changedId;
  document.getElementById("agent-help").textContent = changedId
    ? "操作 ID の変更を保存してから、送信先を選んでください。"
    : "送信先はワークスペースごとに保存します。Orca や端末の再作成後は選び直してください。";
}
function hydrate() {
  controlInput.value = normalize(settings.controlId);
  modeInput.value = settings.mode === "ai" ? "ai" : "shell";
  labelInput.value = settings.label ?? "";
  bodyInput.value = settings.body ?? "";
  closeOnExitInput.checked = settings.closeOnExit === true;
  closeOnSuccessInput.checked = settings.closeOnSuccess === true;
  updateMode();
}
function renderTargets() {
  const selected = draftTargets.has(view.workspaceId)
    ? draftTargets.get(view.workspaceId)
    : settings.agentTargets?.[view.workspaceId];
  agentSelect.replaceChildren(new Option("AIが1つなら自動選択", "auto"));
  for (const target of view.targets ?? [])
    agentSelect.add(
      new Option(`${target.identity} · ${target.name}`, target.handle),
    );
  if (
    selected &&
    !(view.targets ?? []).some(
      (target) =>
        target.handle === selected.handle &&
        target.incarnationId === selected.incarnationId &&
        target.runtimeId === selected.runtimeId &&
        target.identity === selected.identity,
    )
  ) {
    agentSelect.add(
      new Option(
        "保存済みの送信先（現在は確認できません）",
        "saved-unavailable",
      ),
    );
    agentSelect.value = "saved-unavailable";
  } else agentSelect.value = selected?.handle ?? "auto";
  updateMode();
}
function requestView() {
  if (pendingRevision) return;
  const nextId = `${Date.now()}-${Math.random()}`;
  if (
    !send("sendToPlugin", {
      type: "get-execution",
      requestId: nextId,
      includeAgents: modeInput.value === "ai",
    })
  )
    return;
  requestId = nextId;
  refresh.disabled = true;
  clearTimeout(requestTimer);
  clearTimeout(pollTimer);
  requestTimer = setTimeout(() => {
    refresh.disabled = false;
    showMessage(
      "状態の応答を確認できません。Orca の起動状態を確認して、状態を更新してください。",
      true,
    );
  }, 8_000);
}
form.addEventListener("input", () => {
  dirty = true;
  updateMode();
});
modeInput.addEventListener("change", () => {
  dirty = true;
  updateMode();
  requestView();
});
agentSelect.addEventListener("change", () => {
  if (!view?.workspaceId) return;
  if (agentSelect.value === "auto") draftTargets.set(view.workspaceId, null);
  else {
    const target = view.targets.find(
      (target) => target.handle === agentSelect.value,
    );
    if (!target) return;
    draftTargets.set(view.workspaceId, {
      handle: target.handle,
      runtimeId: target.runtimeId,
      incarnationId: target.incarnationId,
      identity: target.identity,
    });
  }
  dirty = true;
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const agentTargets = { ...settings.agentTargets };
  for (const [workspaceId, target] of draftTargets) {
    if (target) agentTargets[workspaceId] = target;
    else delete agentTargets[workspaceId];
  }
  const revision = `${Date.now()}-${Math.random()}`;
  const next = {
    ...settings,
    controlId: normalize(controlInput.value),
    mode: modeInput.value,
    label: labelInput.value,
    body: bodyInput.value,
    closeOnExit: closeOnExitInput.checked,
    closeOnSuccess: closeOnSuccessInput.checked,
    agentTargets,
    revision,
  };
  if (!send("setSettings", next)) {
    showMessage("Stream Deck との接続を確認してください。", true);
    return;
  }
  settings = next;
  pendingRevision = revision;
  dirty = false;
  clearTimeout(requestTimer);
  clearTimeout(pollTimer);
  clearTimeout(saveTimer);
  showMessage("設定を保存しています…");
  saveTimer = setTimeout(() => {
    pendingRevision = undefined;
    showMessage(
      "設定の保存を確認できません。入力は保持しています。アクションを選び直して確認してください。",
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
  hydrate();
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ event: registerEvent, uuid }));
    for (const element of [
      controlInput,
      modeInput,
      labelInput,
      bodyInput,
      closeOnExitInput,
      closeOnSuccessInput,
      save,
      refresh,
    ])
      element.disabled = false;
    updateMode();
    requestView();
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.event === "didReceiveSettings") {
      const received = event.payload.settings ?? {};
      if (pendingRevision && received.revision !== pendingRevision) return;
      pendingRevision = undefined;
      clearTimeout(saveTimer);
      settings = received;
      if (!dirty) {
        draftTargets.clear();
        hydrate();
      }
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
      payload.type !== "execution-view" ||
      payload.requestId !== requestId ||
      payload.controlId !== normalize(settings.controlId)
    )
      return;
    clearTimeout(requestTimer);
    refresh.disabled = false;
    view = payload;
    document.getElementById("workspace-name").textContent =
      payload.workspaceName;
    document.getElementById("workspace-status").textContent =
      `${payload.status} · 候補 ${payload.available} 件`;
    renderTargets();
    showMessage(
      payload.error ||
        (payload.busy
          ? "実行・送信の受付を待っています…"
          : "設定を保存したら、実機のキーを押して実行してください。"),
      Boolean(payload.error),
    );
    if (payload.lastResult) {
      lastResult.textContent = `${payload.lastResult.workspaceName}：${payload.lastResult.message}`;
      lastResult.dataset.error = String(
        ["unknown", "refused"].includes(payload.lastResult.status),
      );
    }
    pollTimer = setTimeout(requestView, 2_000);
  });
  socket.addEventListener("close", () => {
    clearTimeout(requestTimer);
    clearTimeout(pollTimer);
    clearTimeout(saveTimer);
    for (const element of [
      controlInput,
      modeInput,
      labelInput,
      bodyInput,
      closeOnExitInput,
      closeOnSuccessInput,
      agentSelect,
      save,
      refresh,
    ])
      element.disabled = true;
    showMessage(
      "Stream Deck との接続が切れました。入力は保持しています。アクションを選び直してください。",
      true,
    );
  });
  socket.addEventListener("error", () =>
    showMessage("Stream Deck に接続できません。", true),
  );
};
