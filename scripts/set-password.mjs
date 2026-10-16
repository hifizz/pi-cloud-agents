// Usage: node scripts/set-password.mjs <email>
// Reads the password from stdin (hidden on a TTY; one line otherwise, e.g. piped through `fly ssh console`).
// Only emails in TARSBOT_ALLOWED_EMAILS are accepted; minimum 12 characters. Never prints the password.
import { createInterface } from "node:readline";
import { MIN_PASSWORD_LENGTH, normalizeEmail, openAuthStore, parseAllowlist } from "../src/auth.mjs";

function readSecretTty(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const done = (fn, v) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn(v);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(resolve, buf);
        if (ch === "\u0003") return done(reject, new Error("aborted"));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readLine() {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line.replace(/\r$/, "");
  }
  return "";
}

async function main() {
  const email = normalizeEmail(process.argv[2]);
  if (!email) throw new Error("usage: node scripts/set-password.mjs <email>");
  if (!parseAllowlist(process.env.TARSBOT_ALLOWED_EMAILS).has(email)) throw new Error(`${email} is not in TARSBOT_ALLOWED_EMAILS`);
  const password = process.stdin.isTTY ? await readSecretTty("Password: ") : await readLine();
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const store = openAuthStore();
  try {
    await store.setPassword(email, password);
  } finally {
    store.close();
  }
  console.log(`password set for ${email}`);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
