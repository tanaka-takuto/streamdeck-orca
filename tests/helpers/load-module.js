import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { build } from "esbuild";

export async function loadModule(entryPoint) {
  const directory = mkdtempSync(join(tmpdir(), "streamdeck-orca-test-"));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const path = join(directory, "module.cjs");
  writeFileSync(path, result.outputFiles[0].contents);
  return createRequire(import.meta.url)(path);
}
