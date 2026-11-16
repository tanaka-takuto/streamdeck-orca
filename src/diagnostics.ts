import { randomUUID } from "node:crypto";
import streamDeck from "@elgato/streamdeck";
import { diagnosticContext } from "./diagnostic-context";

export type DiagnosticFields = Record<
  string,
  string | number | boolean | undefined
>;
export type Diagnostic = (event: string, fields?: DiagnosticFields) => void;

const sessionId = randomUUID();
let sequence = 0;
/** 設定全体・入力本文・URLを渡さず、操作と停止理由だけを記録する。 */
export const logDiagnostic: Diagnostic = (event, fields = {}) => {
  streamDeck.logger.info(
    JSON.stringify({
      event,
      ...diagnosticContext.getStore(),
      ...fields,
      sessionId,
      sequence: ++sequence,
    }),
  );
};
