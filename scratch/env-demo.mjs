// TEST-F03-1 precheck: write a file through CuaEnv, read it back, and compare with `docker exec ... cat`.
// Run: node scratch/env-demo.mjs
import { execFileSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { config } from "../src/config.mjs";
import { spaceEnv } from "../src/env.mjs";

const ctx = BACKGROUND_CONTEXT;
const container = process.env.CUA_SPACE_NAME ?? "tarsbot-probe";
const env = spaceEnv()({ cwd: config.spaceCwd });
const path = "/home/cua/work/hello.txt";
const stamp = `${new Date().toString()}\n`;

getOrThrow(await env.writeFile(path, stamp, ctx));
const back = getOrThrow(await env.readTextFile(path, ctx));
const info = getOrThrow(await env.fileInfo(path, ctx));
const host = execFileSync("docker", ["exec", container, "cat", path], { encoding: "utf8" });
const viaExec = [];
getOrThrow(await env.exec("echo cwd=$PWD; echo $0; ls hello.txt", { onOutput: (t) => viaExec.push(t) }, ctx));

console.log("written       :", JSON.stringify(stamp));
console.log("read via env  :", JSON.stringify(back));
console.log("docker exec   :", JSON.stringify(host));
console.log("fileInfo      :", JSON.stringify(info));
console.log("exec output   :", JSON.stringify(viaExec.join("")));
const same = back === stamp && host === stamp;
console.log(same ? "OK: env read and docker exec agree" : "MISMATCH");
process.exit(same ? 0 : 1);
