import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BUILD_TIME_ZONE = "Asia/Shanghai";

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BUILD_ID_PATTERN = /^build-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/;
const ANDROID_VERSION_CODE_EPOCH = Date.UTC(2020, 0, 1, 0, 0);
const ANDROID_VERSION_CODE_MAX = 2_100_000_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, "..");

function readReleaseVersion(repoRoot) {
  return readFileSync(resolve(repoRoot, "VERSION"), "utf8").trim();
}

function validateReleaseVersion(version) {
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version '${version}' in VERSION`);
  }
  return version;
}

function buildIdParts(buildId) {
  const match = BUILD_ID_PATTERN.exec(buildId);
  if (!match) {
    throw new Error(`Invalid build id '${buildId}'. Expected build-YYYY-MM-DD-HH-mm`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const parts = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
  };
  const normalized = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  if (
    normalized.getUTCFullYear() !== parts.year
    || normalized.getUTCMonth() + 1 !== parts.month
    || normalized.getUTCDate() !== parts.day
    || normalized.getUTCHours() !== parts.hour
    || normalized.getUTCMinutes() !== parts.minute
  ) {
    throw new Error(`Invalid calendar date in build id '${buildId}'`);
  }
  return parts;
}

export function formatBuildId(now = new Date(), timeZone = DEFAULT_BUILD_TIME_ZONE) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Build time must be a valid Date");
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `build-${values.year}-${values.month}-${values.day}-${values.hour}-${values.minute}`;
}

export function androidVersionCodeFromBuildId(buildId) {
  const parts = buildIdParts(buildId);
  const buildMinute = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const versionCode = Math.floor((buildMinute - ANDROID_VERSION_CODE_EPOCH) / 60_000) + 1;
  if (versionCode < 1 || versionCode > ANDROID_VERSION_CODE_MAX) {
    throw new Error(`Build id '${buildId}' is outside the supported Android versionCode range`);
  }
  return versionCode;
}

function assertMatchingEnvironment(env, name, expected) {
  const actual = env[name]?.trim();
  if (actual && actual !== String(expected)) {
    throw new Error(`${name} '${actual}' does not match derived value '${expected}'`);
  }
}

export function createBuildInfo({
  repoRoot = DEFAULT_REPO_ROOT,
  version,
  now = new Date(),
  env = process.env,
  timeZone = env.CODE_LITE_BUILD_TIME_ZONE?.trim() || DEFAULT_BUILD_TIME_ZONE,
} = {}) {
  const releaseVersion = validateReleaseVersion((version ?? readReleaseVersion(repoRoot)).trim());
  assertMatchingEnvironment(env, "CODE_LITE_VERSION", releaseVersion);

  const buildId = env.CODE_LITE_BUILD_ID?.trim() || formatBuildId(now, timeZone);
  const androidVersionCode = androidVersionCodeFromBuildId(buildId);
  const displayVersion = `${releaseVersion} ${buildId}`;

  assertMatchingEnvironment(env, "CODE_LITE_DISPLAY_VERSION", displayVersion);
  assertMatchingEnvironment(env, "CODE_LITE_ANDROID_VERSION_CODE", androidVersionCode);

  return Object.freeze({
    version: releaseVersion,
    buildId,
    displayVersion,
    androidVersionCode,
    timeZone,
  });
}

export function buildInfoEnvironment(buildInfo) {
  return Object.freeze({
    CODE_LITE_VERSION: buildInfo.version,
    CODE_LITE_BUILD_ID: buildInfo.buildId,
    CODE_LITE_DISPLAY_VERSION: buildInfo.displayVersion,
    CODE_LITE_ANDROID_VERSION_CODE: String(buildInfo.androidVersionCode),
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function runCli() {
  const formatArgument = process.argv.slice(2).find((argument) => argument.startsWith("--format="));
  const format = formatArgument?.slice("--format=".length) || "json";
  const buildInfo = createBuildInfo();

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(buildInfo, null, 2)}\n`);
    return;
  }
  if (format === "shell") {
    const lines = Object.entries(buildInfoEnvironment(buildInfo))
      .map(([name, value]) => `export ${name}=${shellQuote(value)}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  throw new Error(`Unsupported output format '${format}'`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
