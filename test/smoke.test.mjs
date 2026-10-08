import { test } from "node:test";
import assert from "node:assert/strict";

test("core dependencies resolve", async () => {
  const durable = await import("@earendil-works/pi-durable");
  assert.equal(typeof durable.Harness?.open, "function");
  const models = await import("@earendil-works/pi-ai/models");
  assert.equal(typeof models.createModels, "function");
});
