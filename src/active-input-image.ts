import {
  inputWorkspaceText,
  type KeyIcon,
  keyColors,
  keyFrame,
  keyHeader,
  keyName,
  keyText,
} from "./key-layout";
import type { ActiveRecipient } from "./orca/active-input";
import { locationFitsKey } from "./recipient-label";
export function activeInputImage(
  recipient: ActiveRecipient | undefined,
  label: string,
  enter: boolean,
  phase: string,
): string {
  const [status, icon]: [string, KeyIcon] = /不明|未確認/u.test(phase)
    ? ["不明", "question"]
    : /拒否/u.test(phase)
      ? ["拒否", "cross"]
      : /中止/u.test(phase)
        ? ["中止", "pause"]
        : /確認中/u.test(phase)
          ? ["処理", "spinner"]
          : /受付/u.test(phase)
            ? ["受付", "check"]
            : /設定/u.test(phase)
              ? ["設定", "warning"]
              : /取得でき|失敗/u.test(phase)
                ? ["失敗", "warning"]
                : /更新|取得中/u.test(phase)
                  ? ["更新", "spinner"]
                  : ["", "input"];
  const location = recipient
    ? locationFitsKey(recipient.location)
      ? recipient.location
      : "位置不明"
    : "";
  const color = /不明|拒否|中止|設定|失敗/u.test(status)
    ? keyColors.error
    : keyColors.input;
  return keyFrame(
    color,
    keyHeader(status, icon, enter ? "送信" : "入力") +
      keyName(label, 26, 55, 83) +
      keyText(
        recipient ? inputWorkspaceText(recipient.workspace) : "入力先未取得",
        72,
        109,
        20,
      ) +
      keyText(location, 72, 135, 20),
  );
}
