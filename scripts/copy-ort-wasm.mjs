import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmFiles = readdirSync(
  join(root, "node_modules", "onnxruntime-web", "dist"),
).filter((name) => name.startsWith("ort-wasm-") && /\.(wasm|mjs)$/.test(name));

const outDir = join(root, "public", "ort");
mkdirSync(outDir, { recursive: true });

for (const name of wasmFiles) {
  copyFileSync(
    join(root, "node_modules", "onnxruntime-web", "dist", name),
    join(outDir, name),
  );
}

console.log(`Copied onnxruntime-web wasm files to public/ort/: ${wasmFiles.length}`);