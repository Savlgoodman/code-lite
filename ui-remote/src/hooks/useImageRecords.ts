import { useEffect, useSyncExternalStore } from "react";
import { imageGenStore, type ImageRecordMeta } from "../services/ImageGenStore";

/** 订阅生图任务元数据列表快照。 */
export function useImageRecords(): ImageRecordMeta[] {
  useEffect(() => {
    void imageGenStore.init();
  }, []);

  return useSyncExternalStore(imageGenStore.subscribe, imageGenStore.getSnapshot);
}
