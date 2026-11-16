import { AsyncLocalStorage } from "node:async_hooks";

/** 非同期のCLI呼出も、開始元のキー操作へ結び付ける。 */
export const diagnosticContext = new AsyncLocalStorage<{
  actionId: string;
  bindingId: number;
  operationId: number;
}>();
