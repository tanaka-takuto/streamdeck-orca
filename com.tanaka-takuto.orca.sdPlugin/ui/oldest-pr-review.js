const byId = (id) => document.getElementById(id);
const form = byId("review-form"),
  agent = byId("agent"),
  handoff = byId("handoff"),
  body = byId("body"),
  save = byId("save"),
  message = byId("message"),
  selected = byId("selected"),
  state = byId("state"),
  receipt = byId("receipt"),
  refresh = byId("refresh"),
  confirmed = byId("confirmed"),
  forget = byId("forget");
const defaultBody =
  "次のPRをレビューしてください。コードは変更せず、重要な指摘と根拠をまとめてください。\n{{PR_LINK}}";
let socket,
  uuid,
  actionId,
  actionUuid,
  settings = {},
  dirty = false,
  pendingRevision,
  requestId,
  pollTimer,
  timeout,
  saveTimer,
  lastView;
const fields = (s) => ({
  agent: s.agent === "codex" || s.agent === "claude" ? s.agent : "default",
  handoff: s.handoff === "draft" || s.handoff === "send" ? s.handoff : "none",
  body: typeof s.body === "string" ? s.body : defaultBody,
});
const key = (p) => (p ? `${p.repo.toLowerCase()}#${p.number}` : undefined);
function send(event, payload) {
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
}
function mode() {
  body.disabled =
    socket?.readyState !== WebSocket.OPEN || handoff.value === "none";
  byId("handoff-help").textContent =
    handoff.value === "none"
      ? "本文は渡しません。保存した本文は残します。"
      : handoff.value === "draft"
        ? "下書きとして入力し、OrcaでEnterを押すまで送信しません。"
        : "本文を入力して送信します。AIの処理結果はOrcaで確認してください。";
}
function hydrate() {
  const s = fields(settings);
  agent.value = s.agent;
  handoff.value = s.handoff;
  body.value = s.body;
  mode();
}
const identity = (v) =>
  JSON.stringify([v?.accountId, key(v?.candidate), v?.previous?.operationId]);
function controls() {
  forget.disabled =
    !confirmed.checked ||
    !lastView?.selected ||
    key(lastView.selected) !== key(lastView.candidate) ||
    !lastView.previous ||
    lastView.busy ||
    lastView.updating ||
    lastView.partial ||
    dirty ||
    !!pendingRevision;
}
function request(type = "get-oldest-pr-view") {
  clearTimeout(pollTimer);
  if (pendingRevision || socket?.readyState !== WebSocket.OPEN) return;
  requestId = `${Date.now()}-${Math.random()}`;
  refresh.disabled = true;
  send("sendToPlugin", {
    type,
    requestId,
    ...(type === "forget-oldest-pr"
      ? {
          confirmed: confirmed.checked,
          prKey: key(lastView?.selected),
          accountId: lastView?.accountId,
          operationId: lastView?.previous?.operationId,
        }
      : {}),
  });
  clearTimeout(timeout);
  timeout = setTimeout(() => {
    requestId = undefined;
    lastView = undefined;
    selected.textContent = "取得失敗：表示を確認できません。";
    state.textContent = "件数は未確認です。";
    receipt.textContent = "";
    refresh.disabled = false;
    controls();
    pollTimer = setTimeout(() => request(), 2000);
  }, 8000);
}
form.addEventListener("input", () => {
  dirty = true;
  message.textContent =
    "未保存の編集があります。ボタンは保存済み設定で動きます。";
  controls();
});
handoff.addEventListener("change", () => {
  dirty = true;
  mode();
  controls();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (handoff.value !== "none" && !body.value.trim()) {
    message.textContent = "AIに渡す本文を入力してください。";
    return;
  }
  const next = {
    ...settings,
    reviewMode: "personal",
    agent: agent.value,
    handoff: handoff.value,
    enter: handoff.value === "send",
    body: body.value,
    revision: `${Date.now()}-${Math.random()}`,
  };
  if (!send("setSettings", next)) {
    message.textContent = "Stream Deckとの接続を確認してください。";
    return;
  }
  settings = next;
  pendingRevision = next.revision;
  dirty = false;
  requestId = undefined;
  lastView = undefined;
  confirmed.checked = false;
  clearTimeout(timeout);
  clearTimeout(pollTimer);
  clearTimeout(saveTimer);
  controls();
  selected.textContent = "設定の保存中です。";
  state.textContent = "";
  receipt.textContent = "";
  message.textContent = "保存中…";
  saveTimer = setTimeout(() => {
    message.textContent =
      "保存を確認できません。入力は保持しています。設定画面を開き直して確認してください。";
  }, 8000);
});
refresh.addEventListener("click", () => request("refresh-oldest-pr"));
confirmed.addEventListener("change", controls);
forget.addEventListener("click", () => {
  if (!forget.disabled) {
    request("forget-oldest-pr");
    confirmed.checked = false;
    forget.disabled = true;
  }
});
window.connectElgatoStreamDeckSocket = (port, id, register, _info, raw) => {
  const action = JSON.parse(raw);
  uuid = id;
  actionId = action.context;
  actionUuid = action.action;
  settings = action.payload.settings ?? {};
  hydrate();
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ event: register, uuid }));
    for (const el of [agent, handoff, save, refresh]) el.disabled = false;
    mode();
    request();
  });
  socket.addEventListener("close", () => {
    clearTimeout(pollTimer);
    clearTimeout(timeout);
    clearTimeout(saveTimer);
    requestId = undefined;
    lastView = undefined;
    for (const el of [agent, handoff, body, save, refresh]) el.disabled = true;
    selected.textContent = "接続切断・対象未確認";
    state.textContent = "件数は未確認です。";
    receipt.textContent = "";
    message.textContent = "接続が切れました。編集内容は保持しています。";
    controls();
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
      request();
      return;
    }
    const v = event.payload;
    if (
      event.event !== "sendToPropertyInspector" ||
      v?.type !== "oldest-pr-view" ||
      v.actionId !== actionId ||
      !requestId ||
      v.requestId !== requestId ||
      pendingRevision
    )
      return;
    clearTimeout(timeout);
    requestId = undefined;
    pollTimer = setTimeout(() => request(), 2000);
    if (
      JSON.stringify(fields(v.settings ?? {})) !==
      JSON.stringify(fields(settings))
    ) {
      lastView = undefined;
      selected.textContent = "設定の反映を待っています。";
      state.textContent = "";
      receipt.textContent = "";
      controls();
      return;
    }
    if (identity(v) !== identity(lastView)) confirmed.checked = false;
    lastView = v;
    const p = v.selected;
    selected.textContent = v.partial
      ? "検索が一部のため、最古PRは未確定です。"
      : p
        ? `${p.repo} #${p.number}\n${p.title}\n${p.url}\n更新: ${new Date(p.updatedAt).toLocaleString()}`
        : v.error
          ? "取得・表示失敗：レビュー依頼を確認できません。"
          : v.updating
            ? "更新中です…"
            : v.count === 0
              ? "レビュー依頼はありません。"
              : v.count === undefined
                ? "件数・対象は未確認です。"
                : "ボタン表示を確認しています…";
    state.textContent = [
      v.account ? `GitHub: @${v.account}` : "",
      v.partial
        ? "検索が一部のため件数・最古PRは未確定です。起動できません。"
        : v.count === undefined
          ? "件数未確認"
          : `レビュー待ち ${v.count}件`,
      v.busy ? "起動・移動中です。" : v.updating ? "更新中" : "",
      v.error ?? "",
      v.at ? `最終取得: ${new Date(v.at).toLocaleTimeString()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const r = v.record ?? v.previous;
    receipt.textContent =
      v.message ??
      (r
        ? `${r.pr.repo} #${r.pr.number}\n起動時コミット: ${r.pr.sha.slice(0, 12)}\n${r.message}`
        : "");
    refresh.disabled = v.busy;
    message.textContent = dirty
      ? "未保存の編集があります。"
      : (v.error ??
        "同じPRへの再クリックはWSを開きます。AIは重複起動しません。");
    controls();
  });
};
