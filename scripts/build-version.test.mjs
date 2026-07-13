import assert from "node:assert/strict";
import test from "node:test";

import {
  androidVersionCodeFromBuildId,
  buildInfoEnvironment,
  createBuildInfo,
  formatBuildId,
} from "./build-version.mjs";

test("formats build ids in Asia/Shanghai", () => {
  const now = new Date("2026-07-13T15:49:30.000Z");
  assert.equal(formatBuildId(now), "build-2026-07-13-23-49");
});

test("creates a complete build version from the release version", () => {
  const buildInfo = createBuildInfo({
    version: "0.2.1",
    now: new Date("2026-07-13T15:49:30.000Z"),
    env: {},
  });

  assert.deepEqual(buildInfo, {
    version: "0.2.1",
    buildId: "build-2026-07-13-23-49",
    displayVersion: "0.2.1 build-2026-07-13-23-49",
    androidVersionCode: androidVersionCodeFromBuildId("build-2026-07-13-23-49"),
    timeZone: "Asia/Shanghai",
  });
  assert.equal(buildInfoEnvironment(buildInfo).CODE_LITE_ANDROID_VERSION_CODE, String(buildInfo.androidVersionCode));
});

test("reuses and validates an explicit build id", () => {
  const env = { CODE_LITE_BUILD_ID: "build-2026-07-13-23-49" };
  const buildInfo = createBuildInfo({ version: "0.2.1", now: new Date(0), env });
  assert.equal(buildInfo.buildId, env.CODE_LITE_BUILD_ID);

  assert.throws(
    () => createBuildInfo({
      version: "0.2.1",
      env: { ...env, CODE_LITE_DISPLAY_VERSION: "0.2.0 build-2026-07-13-23-49" },
    }),
    /does not match derived value/,
  );
});

test("rejects invalid calendar dates", () => {
  assert.throws(
    () => androidVersionCodeFromBuildId("build-2026-02-30-12-00"),
    /Invalid calendar date/,
  );
});
