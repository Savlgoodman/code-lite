export interface AppBuildInfo {
  readonly version: string;
  readonly buildId: string;
  readonly displayVersion: string;
  readonly androidVersionCode: number;
  readonly timeZone: string;
}

export const APP_BUILD_INFO: AppBuildInfo = Object.freeze({
  ...__CODE_LITE_BUILD_INFO__,
});
