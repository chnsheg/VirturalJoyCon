import test from "node:test";
import assert from "node:assert/strict";

import { computeLayoutMetrics } from "../layout-core.mjs";

test("computeLayoutMetrics enters compact mode on short landscape screens", () => {
  const metrics = computeLayoutMetrics({ width: 980, height: 392 });

  assert.equal(metrics.layoutMode, "compact");
  assert.ok(metrics.stickSize >= 150);
  assert.ok(metrics.stickSize <= 168);
  assert.ok(metrics.faceSize <= 64);
  assert.ok(metrics.smallSize <= 48);
  assert.ok(metrics.triggerHeight <= 118);
  assert.equal(metrics.leftMetaColumn, "3");
  assert.equal(metrics.rightMetaColumn, "4");
  assert.equal(metrics.leftMetaRow, "2");
  assert.equal(metrics.rightMetaRow, "2");
  assert.equal(metrics.triggerLabelSideOffset, "calc(100% + 8px)");
  assert.ok(metrics.faceClusterScale >= 2.35);
});

test("computeLayoutMetrics keeps larger controls on roomy displays", () => {
  const metrics = computeLayoutMetrics({ width: 1366, height: 768 });

  assert.equal(metrics.layoutMode, "regular");
  assert.ok(metrics.stickSize >= 236);
  assert.ok(metrics.faceSize >= 80);
  assert.ok(metrics.smallSize >= 58);
  assert.ok(metrics.triggerHeight >= 170);
  assert.equal(metrics.leftMetaColumn, "2");
  assert.equal(metrics.rightMetaColumn, "5");
  assert.equal(metrics.leftMetaRow, "3");
  assert.equal(metrics.rightMetaRow, "3");
  assert.equal(metrics.triggerLabelSideOffset, "calc(100% + 10px)");
  assert.ok(metrics.faceClusterScale >= 2.2);
});

test("computeLayoutMetrics keeps immersive top padding tight across landscape layouts", () => {
  const roomy = computeLayoutMetrics({ width: 1366, height: 768 });
  const compact = computeLayoutMetrics({ width: 980, height: 392 });

  assert.equal(roomy.padTop, 8);
  assert.equal(compact.padTop, 6);
});
