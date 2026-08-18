import test from "node:test";
import assert from "node:assert/strict";
import { selectRuntimeAdapter } from "../../src/installer/ship-adapter.js";

test("runtime adapter: valid ship config overrides preserved delivery.json", () => {
  assert.equal(typeof selectRuntimeAdapter, "function");
  const shipAdapter = { source: "ship.config.json" };
  const legacyAdapter = { ok: true, adapter: { source: "delivery.json" } };
  assert.equal(
    selectRuntimeAdapter({ config: { ok: true }, shipAdapter, legacyAdapter }),
    shipAdapter,
  );
});

test("runtime adapter: legacy delivery.json is fallback when ship config is absent", () => {
  const shipAdapter = { source: "defaults" };
  const legacyAdapter = { ok: true, adapter: { source: "delivery.json" } };
  assert.equal(
    selectRuntimeAdapter({ config: null, shipAdapter, legacyAdapter }),
    legacyAdapter.adapter,
  );
});
