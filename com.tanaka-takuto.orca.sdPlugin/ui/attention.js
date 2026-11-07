const el = (id) => document.getElementById(id);
let socket,
  inspectorId,
  actionId,
  actionUuid,
  requestId,
  requestTimer,
  pollTimer;
let pending = false;
const write = (id, text) => {
  if (el(id).textContent !== text) el(id).textContent = text;
};
function message(text, error = false) {
  write("message", text);
  el("message").dataset.error = String(error);
}
function requestView() {
  if (socket?.readyState !== WebSocket.OPEN || pending) return;
  pending = true;
  clearTimeout(requestTimer);
  clearTimeout(pollTimer);
  requestId = `${Date.now()}-${Math.random()}`;
  el("refresh").setAttribute("aria-busy", "true");
  socket.send(
    JSON.stringify({
      event: "sendToPlugin",
      context: inspectorId,
      action: actionUuid,
      payload: { type: "get-attention", requestId },
    }),
  );
  requestTimer = setTimeout(() => {
    pending = false;
    el("refresh").setAttribute("aria-busy", "false");
    write("counts", "現在の件数を確認できません");
    message(
      "応答を確認できません。Orcaの起動状態を確認して、状態を更新してください。",
      true,
    );
  }, 8000);
}
function render(v) {
  const c = v.current;
  write("target-project", c ? `${c.project || "Orca"} · ${c.tag || ""}` : "");
  write(
    "target-name",
    c?.name ||
      (v.coverage === "offline"
        ? "取得できません"
        : v.coverage === "loading"
          ? "取得しています…"
          : "候補なし"),
  );
  write("target-path", c?.path || "");
  write(
    "target-reason",
    c
      ? (c.kind === "waiting" ? "入力待ちを報告" : "返答・ブロックを報告") +
          (c.working ? " · 別のAIは進行中" : "")
      : v.coverage === "offline"
        ? "Orcaの接続を確認してください"
        : v.coverage === "loading"
          ? "候補を確認中です"
          : v.counts.workspaces === 0
            ? "ワークスペースなし"
            : v.counts.agents === 0
              ? "対象AIなし。Orcaの通知フック設定も確認してください。"
              : v.counts.working
                ? "進行中のAIがあります"
                : "既知の入力待ち・返答候補はありません",
  );
  const unavailable = v.coverage === "offline" || v.coverage === "loading";
  write(
    "counts",
    unavailable
      ? "件数を確認できません"
      : `入力待ち ${v.counts.waiting} WS · 返答候補 ${v.counts.review} WS`,
  );
  const warning = v.fromCache
    ? "保持表示です。最新状態を取得しています。"
    : v.coverage === "partial"
      ? "一部取得：未取得のホストや打ち切られた一覧があります。候補なしでも全件確認できたとは限りません。"
      : v.coverage === "unknown"
        ? `一部不明：${v.counts.unknown} WSの状態が不明です。表示件数は既知の範囲です。`
        : v.error ||
          (unavailable
            ? "Orcaの状態を取得しています。"
            : "取得した範囲を表示しています。開いても件数は減りません。");
  message(warning, v.coverage !== "complete" && v.coverage !== "loading");
  write(
    "received",
    v.receivedAt
      ? `最終成功取得 ${new Date(v.receivedAt).toLocaleTimeString("ja-JP")}${unavailable ? "（現在は未取得）" : ` · ${v.counts.workspaces} WS`}`
      : "",
  );
  if (v.result) {
    const labels = {
      opened: "開きました",
      changed: "移動を中止",
      unconfirmed: "移動を確認できません",
    };
    write(
      "result",
      `${v.result.project} / ${v.result.workspaceName}\n${labels[v.result.status]}：${v.result.message}`,
    );
  }
}
el("refresh").addEventListener("click", requestView);
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
    el("refresh").disabled = false;
    requestView();
  });
  socket.addEventListener("message", ({ data }) => {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const p = event.payload;
    if (event.event !== "sendToPropertyInspector" || p?.actionId !== actionId)
      return;
    if (p.type === "error") {
      message(p.message, true);
      return;
    }
    if (p.type !== "attention-view" || p.requestId !== requestId) return;
    clearTimeout(requestTimer);
    pending = false;
    el("refresh").setAttribute("aria-busy", "false");
    render(p.view);
    pollTimer = setTimeout(requestView, 2000);
  });
  socket.addEventListener("close", () => {
    pending = false;
    clearTimeout(requestTimer);
    clearTimeout(pollTimer);
    el("refresh").disabled = true;
    write("counts", "現在の件数を確認できません");
    message(
      "Stream Deckとの接続が切れました。アクションを選び直してください。",
      true,
    );
  });
  socket.addEventListener("error", () =>
    message("Stream Deckに接続できません。", true),
  );
};
