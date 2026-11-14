import { Button, Surface } from "./ios/controls";
import { Loader } from "./ios/effects";

/** Deliberately contains no title, cover or media element. */
export function ContentBlockNotice({ reason, onViewOnce, onBack, onSettings, busy = false, onRetry }: {
  reason: string; onViewOnce?: () => void; onBack: () => void; onSettings?: () => void;
  busy?: boolean; onRetry?: () => void;
}) {
  return <div className="absolute inset-0 bg-bg flex items-center justify-center p-5" data-content-block-notice>
    <Surface className="w-full max-w-md rounded-(--r-lg) p-6 text-center">
      {busy && <Loader label="正在检查内容标签" />}
      <h1 className="text-[18px] font-bold text-on mt-2">{busy ? "正在检查内容标签" : onRetry ? "标签读取失败" : "内容已屏蔽"}</h1>
      <p role="status" className="mt-3 text-[14px] text-mut break-words">{reason}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <Button className="px-5 rounded-full bg-s3" onClick={onBack}>返回</Button>
        {onViewOnce && <Button variant="primary" className="px-5 rounded-full" onClick={onViewOnce}>本次查看</Button>}
        {onRetry && <Button variant="primary" className="px-5 rounded-full" onClick={onRetry}>重试标签</Button>}
      </div>
      {onSettings && <Button className="mt-3 px-4 text-primary" onClick={onSettings}>管理屏蔽标签</Button>}
    </Surface>
  </div>;
}
