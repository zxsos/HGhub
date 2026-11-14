import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Feed from "../components/Feed";
import { api } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch } from "../icons";
import { Empty } from "../components/ui";

/* Fisher-Yates 洗牌：首页第一页随机打乱，避免每次进来都停在同一个 top1 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast, lineEpoch } = useStore();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mounted = useRef(false);
  const attemptedEpoch = useRef<number | null>(null);
  const [feedMounted, setFeedMounted] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /* 翻页失败退避：失败后 5 秒内不再因滚动触发重试，连续失败只提示一次 */
  const retryAt = useRef(0);
  const failStreak = useRef(0);
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const load = useCallback(async (p: number): Promise<void> => {
    if (!activeRef.current || loadingRef.current || (done && p > 1)) return;
    const requestEpoch = lineEpochRef.current;
    if (p === 1) attemptedEpoch.current = requestEpoch;
    let retryAfterLineChange = false;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    if (p === 1) setDone(false);
    try {
      const res = await api.feed(p, 30);
      if (!mounted.current) return;
      if (requestEpoch !== lineEpochRef.current) { retryAfterLineChange = !itemsRef.current.length; return; }
      const list = res?.items || [];
      const ordered = p === 1 ? shuffle(list) : list;
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...ordered.filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      failStreak.current = 0;
      retryAt.current = 0;
      setDone(!list.length || !!(res?.pagination && p >= res.pagination.pages));
    } catch (e) {
      if (!mounted.current) return;
      const message = (e as Error).message || "加载失败";
      const stale = requestEpoch !== lineEpochRef.current;
      if (!stale) {
        setError(message);
        if (p > 1) retryAt.current = Date.now() + 5000;
        if (failStreak.current++ === 0) toast(message, "info");
      }
      /* 请求在旧线路上发出、期间线路已切换：等 finally 里用新线路补拉一次 */
      if (stale && !itemsRef.current.length) retryAfterLineChange = true;
    } finally {
      loadingRef.current = false;
      if (!mounted.current) return;
      setLoading(false);
      if (retryAfterLineChange && activeRef.current) {
        setDone(false);
        setError("");
        void load(1);
      }
    }
  }, [done, toast]);

  /* A never-visited/hidden home does no new work. New-line retries resume on return.
     Loaded pages and an already mounted player remain intact across navigation. */
  useEffect(() => {
    if (!active || items.length || loadingRef.current || attemptedEpoch.current === lineEpoch) return;
    void load(1);
  }, [active, lineEpoch, items.length, load]);
  useEffect(() => { if (active && items.length) setFeedMounted(true); }, [active, items.length]);

  const ids = useMemo(() => items.map((v) => v.id), [items]);

  return (
    <div className="absolute inset-0 bg-black">
      {items.length && (active || feedMounted) ? (
        <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset}
          onNearEnd={() => { if (!loading && !done && Date.now() >= retryAt.current) load(page + 1); }} />
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void load(1)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title="暂无视频" sub="稍后刷新试试" action="刷新" onAction={() => void load(1)} /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>
      )}
    </div>
  );
}
