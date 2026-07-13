// 传输适配接口：由各端注入具体 HTTP 实现（桌面端基于 backend base_url 的 fetch，
// 远程端后续注入中继转发）。本包只依赖这个接口，不关心 CORS/密钥/落盘。

export interface ImageGenTransport {
  /** JSON 请求，method 默认按语义在 client 内指定。 */
  request<T>(
    path: string,
    init: { method: string; body?: unknown }
  ): Promise<T>;
  /** multipart 上传（参考图）。 */
  upload<T>(path: string, form: FormData): Promise<T>;
}
