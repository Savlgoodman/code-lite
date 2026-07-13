export interface BuildInfo {
  readonly version: string;
  readonly buildId: string;
  readonly displayVersion: string;
  readonly androidVersionCode: number;
  readonly timeZone: string;
}

export interface CreateBuildInfoOptions {
  repoRoot?: string;
  version?: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  timeZone?: string;
}

export const DEFAULT_BUILD_TIME_ZONE: string;
export function formatBuildId(now?: Date, timeZone?: string): string;
export function androidVersionCodeFromBuildId(buildId: string): number;
export function createBuildInfo(options?: CreateBuildInfoOptions): Readonly<BuildInfo>;
export function buildInfoEnvironment(buildInfo: BuildInfo): Readonly<Record<string, string>>;
