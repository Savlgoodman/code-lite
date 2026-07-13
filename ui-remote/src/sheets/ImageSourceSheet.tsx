import { Camera, Images } from "lucide-react";
import { Sheet } from "../components/ui";

interface ImageSourceSheetProps {
  onClose: () => void;
  onChooseGallery: () => void;
  onTakePhoto: () => void;
}

/** 图片来源选择：动作在原始点击事件中启动，确保原生选择器拿到用户手势。 */
export function ImageSourceSheet({ onClose, onChooseGallery, onTakePhoto }: ImageSourceSheetProps) {
  return (
    <Sheet title="添加图片" onClose={onClose} bodyClassName="image-source-sheet-body">
      {(close) => (
        <div className="image-source-actions">
          <button
            type="button"
            className="image-source-action"
            onClick={() => {
              onChooseGallery();
              close();
            }}
          >
            <Images size={21} />
            <span>从相册选择</span>
          </button>
          <button
            type="button"
            className="image-source-action"
            onClick={() => {
              onTakePhoto();
              close();
            }}
          >
            <Camera size={21} />
            <span>拍照</span>
          </button>
        </div>
      )}
    </Sheet>
  );
}
