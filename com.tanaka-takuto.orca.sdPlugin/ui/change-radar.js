const input = document.getElementById("control-id"),
  save = document.getElementById("save"),
  form = document.getElementById("radar-form"),
  message = document.getElementById("message"),
  contact = document.getElementById("contact"),
  details = document.getElementById("details"),
  coverage = document.getElementById("coverage");
let socket,
  uuid,
  actionId,
  actionUuid,
  settings = {},
  requestId,
  pollTimer,
  timeout,
  revision,
  saveTimer,
  dirty = false;
const send = (event, payload) => {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(
    JSON.stringify({
      event,
      context: uuid,
      ...(event === "sendToPlugin" ? { action: actionUuid } : {}),
      payload,
    }),
  );
  return true;
};
function clearTarget(text) {
  contact.textContent = text;
  details.textContent = "";
}
function poll() {
  if (revision) return;
  clearTimeout(pollTimer);
  requestId = `${Date.now()}-${Math.random()}`;
  send("sendToPlugin", { type: "get-radar-view", requestId });
  clearTimeout(timeout);
  timeout = setTimeout(() => {
    requestId = undefined;
    clearTarget("取得を確認できません。レーダーの表示を確認してください。");
    pollTimer = setTimeout(poll, 2000);
  }, 5000);
}
form.addEventListener("input", () => {
  dirty = true;
  message.textContent =
    "未保存の操作IDがあります。保存後にレーダーへ反映します。";
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const next = {
    ...settings,
    controlId: input.value.trim() || "main",
    revision: `${Date.now()}-${Math.random()}`,
  };
  if (!send("setSettings", next)) return;
  settings = next;
  revision = next.revision;
  dirty = false;
  requestId = undefined;
  clearTimeout(timeout);
  clearTimeout(pollTimer);
  clearTimeout(saveTimer);
  clearTarget("操作IDの保存中です。");
  message.textContent = "保存中…";
  saveTimer = setTimeout(() => {
    message.textContent =
      "保存を確認できません。入力は保持しています。選び直して確認してください。";
  }, 8000);
});
window.connectElgatoStreamDeckSocket = (port, id, register, _info, raw) => {
  const action = JSON.parse(raw);
  uuid = id;
  actionId = action.context;
  actionUuid = action.action;
  settings = action.payload.settings ?? {};
  input.value = settings.controlId || "main";
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ event: register, uuid }));
    input.disabled = false;
    save.disabled = false;
    message.textContent = "同じ操作IDの選択ワークスペースを比較します。";
    poll();
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.event === "didReceiveSettings") {
      const received = event.payload.settings ?? {};
      if (revision && received.revision !== revision) return;
      revision = undefined;
      clearTimeout(saveTimer);
      settings = received;
      if (!dirty) input.value = settings.controlId || "main";
      message.textContent = dirty
        ? "未保存の編集があります。"
        : "設定を保存しました。";
      poll();
      return;
    }
    const v = event.payload;
    if (
      event.event !== "sendToPropertyInspector" ||
      v?.type !== "radar-view" ||
      v.actionId !== actionId ||
      v.requestId !== requestId ||
      revision
    )
      return;
    clearTimeout(timeout);
    requestId = undefined;
    pollTimer = setTimeout(poll, 2000);
    if (v.controlId !== (settings.controlId?.trim() || "main")) {
      clearTarget("操作IDの反映を待っています。");
      coverage.textContent = "";
      return;
    }
    const c = v.displayed;
    const destination = (side) =>
      side.open === "workspace"
        ? "ワークスペース（そこで確認）"
        : side.open === "staged"
          ? "ステージ差分全体"
          : `コードの${side.line}行目`;
    contact.textContent = c
      ? [
          `自分: ${c.self.workspace.name}`,
          `相手: ${c.peer.workspace.name}`,
          c.path,
          {
            lines: "共通基点で同じ行域",
            file: "同じファイル・異なる行域",
            same: "現在の内容が同じ",
            structure: "追加・削除等を含む",
            manual: "行域は手動で確認",
          }[c.kind],
          c.ranges,
          `押す → 自分側の${destination(c.self)}`,
          `タップ → 相手側の${destination(c.peer)}`,
          v.updating
            ? "更新中・開く操作は待ってください"
            : "押す:自分 / タップ:相手",
        ].join("\n")
      : v.error || v.updating
        ? "比較中・取得できない場合があります。"
        : v.contact
          ? "表示を更新しています。"
          : "表示できる接点はありません。";
    details.textContent = c
      ? [
          `自分 ${c.self.workspace.project}\n${c.self.workspace.path}\nWS: ${c.self.workspace.id}\n開く行: ${destination(c.self)}`,
          `相手 ${c.peer.workspace.project}\n${c.peer.workspace.path}\nWS: ${c.peer.workspace.id}\n開く行: ${destination(c.peer)}`,
          `共通基点: ${c.base}`,
          `比較版: ${c.fingerprint}`,
        ].join("\n\n")
      : "";
    const r = v.result;
    coverage.textContent = [
      r
        ? `最終取得: ${new Date(r.at).toLocaleString()}\n比較 ${r.compared}WS / 接点 ${r.contacts.length}件 / 対象外・未比較 ${r.skipped.length}WS`
        : "比較結果なし",
      v.context?.partial
        ? "Orca一覧が一部のため、他の接点が残る場合があります。"
        : "",
      ...(r?.skipped ?? []).map((x) => `${x.name}: ${x.reason}`),
      v.error || "",
      v.message || "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  socket.addEventListener("close", () => {
    clearTimeout(pollTimer);
    clearTimeout(timeout);
    clearTimeout(saveTimer);
    requestId = undefined;
    input.disabled = true;
    save.disabled = true;
    clearTarget("接続が切れました。入力は保持しています。");
    message.textContent = "Stream Deckとの接続を確認してください。";
  });
};
