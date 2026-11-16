import { basename } from "node:path";
import type { DiagnosticFields } from "./diagnostics";

/** 例外本文は複製せず、エラー種別・コードと関数/ファイル/行の位置を残す。 */
export function errorDetails(error: unknown): DiagnosticFields {
  const fields: DiagnosticFields = { errorType: typeof error };
  let value = error;
  for (let depth = 0; depth < 4 && value instanceof Error; depth++) {
    const prefix = depth === 0 ? "error" : "cause";
    fields[`${prefix}Type`] = value.name;
    const code = "code" in value ? value.code : undefined;
    if (
      typeof code === "number" ||
      (typeof code === "string" && /^[\w.-]{1,80}$/u.test(code))
    )
      fields[`${prefix}Code`] = code;
    const frames = value.stack
      ?.split("\n")
      .flatMap((line) => {
        const match = /^\s+at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/u.exec(line);
        return match
          ? [
              `${match[1] ?? "<anonymous>"} (${basename(match[2])}:${match[3]}:${match[4]})`,
            ]
          : [];
      })
      .slice(0, 12);
    if (frames?.length) fields[`${prefix}Frames`] = JSON.stringify(frames);
    value = value.cause;
  }
  if (error === "The request timed out")
    fields.errorCode = "SDK_REQUEST_TIMEOUT";
  return fields;
}
