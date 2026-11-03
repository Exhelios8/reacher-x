import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const output = ".cloudflare/output/v0/workers/default";
const configPath = join(output, "worker.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
assert.equal(config.manifest.type, "partial");
assert(config.manifest.mainModule && config.manifest.modules);

// Keep runtime file reads in the Worker's private /bundle filesystem.
const files = [
  ...readdirSync("content/blog")
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => `content/blog/${name}`),
  "content/blog-examples/content.mdx",
  "node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf",
];

for (const file of files) {
  const target = join(output, "bundle", file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  config.manifest.modules[file] = {
    type: file.endsWith(".ttf") ? "data" : "text",
  };
  assert(readFileSync(target).equals(readFileSync(file)), file);
}

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Packaged ${files.length} private runtime files for Cloudflare.`);
