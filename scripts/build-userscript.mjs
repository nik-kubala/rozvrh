import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parts = ["optimizer-core.js", "data.js", "fixes.js", "fixed-plans.js", "preferences.js", "scripts/userscript-runtime.js"];
const metadata = `// ==UserScript==
// @name         EDISON Rozvrh Assistant
// @namespace    https://github.com/nik-kubala/rozvrh
// @version      1.0.0
// @description  Bezpečný adaptívny zápis rozvrhu VŠB-TUO s DRY RUN, ARM/START/STOP a robustnými fallbackmi.
// @author       nik-kubala
// @match        https://edison.sso.vsb.cz/wps/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==`;

const body = parts.map((file) => `\n/* bundled from ${file} — edit the source file, then run npm run build:userscript */\n${fs.readFileSync(path.join(root, file), "utf8").trim()}\n`).join("");
fs.writeFileSync(path.join(root, "edison-rozvrh-assistant.user.js"), `${metadata}\n${body}`);
console.log(`Built edison-rozvrh-assistant.user.js from ${parts.length} shared sources.`);
