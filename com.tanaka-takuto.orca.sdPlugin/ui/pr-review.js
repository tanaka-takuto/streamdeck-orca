const form = document.getElementById("review-form"),
  mode = document.getElementById("review-mode"),
  agent = document.getElementById("agent"),
  body = document.getElementById("body"),
  enter = document.getElementById("enter"),
  save = document.getElementById("save"),
  message = document.getElementById("message"),
  selected = document.getElementById("selected"),
  state = document.getElementById("state"),
  receipt = document.getElementById("receipt"),
  refresh = document.getElementById("refresh"),
  confirmed = document.getElementById("confirmed"),
  forget = document.getElementById("forget");
const defaultBody =
  "次のPRをレビューしてください。コードは変更せず、重要な指摘と根拠をまとめてください。\n{{pr_url}}";
let socket,
  uuid,
  actionId,
  actionUuid,
  settings = {},
  dirty = false,
  revision,
  requestId,
  timer,
  timeout,
  saveTimer,
  lastView;
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
function fields(s) {
  return {
    reviewMode: s.reviewMode === "team" ? "team" : "personal",
    agent: s.agent === "claude" ? "claude" : "codex",
    body: typeof s.body === "string" ? s.body : defaultBody,
    enter: s.enter === true,
  };
}
function showForm() {
  const s = fields(settings);
  mode.value = s.reviewMode;
  agent.value = s.agent;
  body.value = s.body;
  enter.checked = s.enter;
}
function key(p) {
  return p ? `${p.repo.toLowerCase()}#${p.number}` : undefined;
}
function recordIdentity(v) {
  return JSON.stringify([
    v?.accountId,
    key(v?.candidate),
    v?.previous?.operationId,
    v?.previous?.pr?.sha,
  ]);
}
function canForget() {
  forget.disabled =
    !confirmed.checked ||
    !lastView?.selected ||
    key(lastView?.selected) !== key(lastView?.candidate) ||
    !lastView?.previous ||
    lastView?.busy ||
    lastView?.updating ||
    dirty ||
    !!revision;
}
function poll(type = "get-pr-review-view") {
  clearTimeout(timer);
  if (revision || socket?.readyState !== WebSocket.OPEN) return;
  requestId = `${Date.now()}-${Math.random()}`;
  send("sendToPlugin", {
    type,
    requestId,
    ...(type === "forget-pr-review"
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
    selected.textContent = "表示を確認できません。接続を確認してください。";
    state.textContent = "";
    receipt.textContent = "";
    canForget();
    timer = setTimeout(poll, 2000);
  }, 5000);
}
form.addEventListener("input", () => {
  dirty = true;
  message.textContent =
    "未保存の編集があります。実機は保存済みの設定で動きます。";
  canForget();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!body.value.trim()) {
    message.textContent = "AIに渡すテキストを入力してください。";
    return;
  }
  const next = {
    ...settings,
    reviewMode: mode.value,
    agent: agent.value,
    body: body.value,
    enter: enter.checked,
    revision: `${Date.now()}-${Math.random()}`,
  };
  if (!send("setSettings", next)) return;
  settings = next;
  revision = next.revision;
  dirty = false;
  requestId = undefined;
  lastView = undefined;
  confirmed.checked = false;
  clearTimeout(timeout);
  clearTimeout(timer);
  clearTimeout(saveTimer);
  canForget();
  selected.textContent = "設定の保存中です。";
  state.textContent = "";
  receipt.textContent = "";
  message.textContent = "保存中…";
  saveTimer = setTimeout(() => {
    message.textContent =
      "保存を確認できません。入力は保持しています。接続を確認してください。";
  }, 8000);
});
confirmed.addEventListener("change", canForget);
forget.addEventListener("click", () => {
  if (!forget.disabled) {
    poll("forget-pr-review");
    confirmed.checked = false;
    forget.disabled = true;
  }
});
refresh.addEventListener("click", () => {
  send("sendToPlugin", {
    type: "refresh-pr-review",
    requestId: `${Date.now()}`,
  });
  poll();
});
window.connectElgatoStreamDeckSocket = (port, id, register, _info, raw) => {
  const action = JSON.parse(raw);
  uuid = id;
  actionId = action.context;
  actionUuid = action.action;
  settings = action.payload.settings ?? {};
  showForm();
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ event: register, uuid }));
    for (const field of [mode, agent, body, enter, save, refresh])
      field.disabled = false;
    message.textContent = "保存済みの設定を実機に反映します。";
    poll();
  });
  socket.addEventListener("close", () => {
    clearTimeout(timer);
    clearTimeout(timeout);
    lastView = undefined;
    for (const field of [mode, agent, body, enter, save, refresh])
      field.disabled = true;
    message.textContent = "接続が切れました。編集内容は保持しています。";
    canForget();
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.event === "didReceiveSettings") {
      const received = event.payload.settings ?? {};
      if (revision && received.revision !== revision) return;
      revision = undefined;
      clearTimeout(saveTimer);
      settings = received;
      if (!dirty) showForm();
      message.textContent = dirty
        ? "未保存の編集があります。実機は保存済み設定で動きます。"
        : "設定を保存しました。保存だけではAIは起動しません。";
      poll();
      return;
    }
    const v = event.payload;
    if (
      event.event !== "sendToPropertyInspector" ||
      v?.type !== "pr-review-view" ||
      v.actionId !== actionId ||
      v.requestId !== requestId ||
      revision
    )
      return;
    clearTimeout(timeout);
    requestId = undefined;
    timer = setTimeout(poll, 2000);
    if (
      JSON.stringify(fields(v.settings ?? {})) !==
      JSON.stringify(fields(settings))
    ) {
      lastView = undefined;
      selected.textContent = "設定の反映を待っています。";
      state.textContent = "";
      receipt.textContent = "";
      canForget();
      return;
    }
    if (recordIdentity(lastView) !== recordIdentity(v))
      confirmed.checked = false;
    lastView = v;
    const p = v.selected;
    selected.textContent = p
      ? `${p.repo} #${p.number}\n${p.title}\n${p.url}`
      : v.error
        ? "レビュー依頼を取得・表示できません。"
        : v.updating
          ? "GitHubから取得しています…"
          : v.count
            ? "ダイヤル表示の反映を待っています。"
            : "対象のレビュー依頼はありません。";
    state.textContent = [
      v.account ? `GitHub: @${v.account}` : "",
      `${v.count}件${v.partial ? "（取得上限または一部の結果）" : ""}`,
      v.updating ? "更新中" : "",
      v.busy ? "AI起動を準備中です。" : "",
      v.error ?? "",
      v.at ? `最終取得: ${new Date(v.at).toLocaleTimeString()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const r = v.record ?? v.previous;
    receipt.textContent =
      v.message ??
      (r
        ? `${r.pr.repo} #${r.pr.number}\n${r.message}\n操作ID: ${r.operationId}`
        : "");
    refresh.disabled = v.busy || !!revision;
    canForget();
  });
};
