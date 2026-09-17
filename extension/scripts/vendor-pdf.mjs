import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules", "pdfjs-dist");
const target = resolve(root, "vendor");

await mkdir(target, { recursive: true });
await Promise.all([
  copyFile(resolve(source, "build", "pdf.mjs"), resolve(target, "pdf.mjs")),
  copyFile(resolve(source, "build", "pdf.worker.mjs"), resolve(target, "pdf.worker.mjs")),
  copyFile(resolve(source, "LICENSE"), resolve(target, "PDFJS-LICENSE.txt")),
]);

console.log("Vendored PDF.js into extension/vendor");
