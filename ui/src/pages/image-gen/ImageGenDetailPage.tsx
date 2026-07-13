import { useImageGenDetail } from "./useImageGenDetail";
import { ImageGenDetailView } from "./ImageGenDetailView";

interface ImageGenDetailPageProps {
  recordId: string;
  onBack: () => void;
  onRecordChanged?: () => void;
}

// 薄封装：把状态逻辑拆到 useImageGenDetail hook，视图拆到 ImageGenDetailView，避免单文件过大。
export function ImageGenDetailPage({ recordId, onBack, onRecordChanged }: ImageGenDetailPageProps) {
  const state = useImageGenDetail(recordId, onRecordChanged);
  return <ImageGenDetailView onBack={onBack} state={state} />;
}
