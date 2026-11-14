import { useEffect, useState } from "react";
import { MAX_BLOCKED_TAGS, MAX_TAG_LENGTH, normalizeTag, useContentPreferences } from "../contentPreferences";
import { Button } from "./ios/controls";
import { Sheet } from "./ui";

export function TagBlockMenu({ open, tags, onClose, onSettings }: {
  open: boolean; tags: readonly string[]; onClose: () => void; onSettings?: () => void;
}) {
  const { preferences, blockTags, isTagBlocked } = useContentPreferences();
  const [selected, setSelected] = useState<string[]>([]);
  const names = tags.map(tag => typeof tag === "string" ? tag.trim().replace(/\s+/g, " ") : "");
  const options = names.filter((tag, index) => tag
    && names.findIndex(value => normalizeTag(value) === normalizeTag(tag)) === index);
  const identity = options.join("\u0000");
  useEffect(() => { setSelected([]); }, [open, identity]);
  const capacity = Math.max(0, MAX_BLOCKED_TAGS - preferences.blockedTags.length);
  const validSelected = selected.filter(tag => !isTagBlocked(tag) && tag.trim().length <= MAX_TAG_LENGTH).slice(0, capacity);
  return <Sheet open={open} onClose={onClose} label="不感兴趣">
    <div className="p-5">
      <h2 className="text-[18px] font-bold">不感兴趣</h2>
      <p className="mt-2 text-[14px] text-mut">选择要屏蔽的标签。命中任一标签的内容会按场景隐藏，不会删除收藏或历史。</p>
      {options.length ? <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="选择屏蔽标签">
        {options.map(tag => <Button key={normalizeTag(tag)} disabled={isTagBlocked(tag) || tag.trim().length > MAX_TAG_LENGTH || (!selected.includes(tag) && validSelected.length >= capacity)} aria-pressed={selected.includes(tag) || isTagBlocked(tag)}
          className={`rounded-full px-4 min-h-11 break-words max-w-full ${selected.includes(tag) ? "bg-primary text-on-primary" : "bg-s3"}`}
          onClick={() => setSelected(previous => previous.includes(tag) ? previous.filter(value => value !== tag) : [...previous, tag])}>
          {tag}{isTagBlocked(tag) ? " · 已屏蔽" : tag.trim().length > MAX_TAG_LENGTH ? " · 标签过长" : ""}
        </Button>)}
      </div> : <p className="mt-4 text-[14px] text-mut">这条内容没有可用标签，可到设置中管理内容偏好。</p>}
      {capacity === 0 && <p role="status" className="mt-3 text-[14px] text-mut">已达到 {MAX_BLOCKED_TAGS} 个屏蔽标签上限，请到设置中清理后再添加。</p>}
      {capacity > 0 && capacity < options.filter(tag => !isTagBlocked(tag)).length && <p role="status" className="mt-3 text-[14px] text-mut">还可添加 {capacity} 个标签。</p>}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button className="flex-1 rounded-full bg-s3 px-4" onClick={onClose}>取消</Button>
        {options.length > 0 && <Button variant="primary" disabled={!validSelected.length} className="flex-1 rounded-full px-4" onClick={() => { blockTags(validSelected); onClose(); }}>屏蔽所选标签</Button>}
      </div>
      {onSettings && <Button className="mt-2 px-3 text-primary" onClick={() => { onClose(); onSettings(); }}>管理屏蔽标签</Button>}
    </div>
  </Sheet>;
}
