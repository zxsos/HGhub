import { useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { AppProvider, useStore } from "../src/store";
import { useContentPreferences } from "../src/contentPreferences";
import Feed from "../src/components/Feed";
import Home from "../src/pages/Home";
import type { Detail, VideoCard } from "../src/types";
import "../src/index.css";

const params = new URLSearchParams(location.search);
type Pending = { id: number; resolve: (value: Detail) => void; reject: (error: Error) => void };
const pending: Pending[] = [];
const card = (id: number, tags?: string[]): VideoCard => ({
  id, title: `自然观察 ${id}`, cover: `https://fixture.invalid/cover/${id}`, tags,
  score: 0, hot: 0, episode_count: 2, total_episodes: 2,
} as VideoCard);
const detail = (id: number, tags?: string[]): Detail => ({ ...card(id, tags), duration: 60, description: "中性自然观察示例。",
  author: { id: 1, name: "示例作者" }, counts: { like: 0, collect: 0, comment: 0, hot: 0 },
  episodes: [1, 2].map(ep_num => ({ ep_num, title: `第 ${ep_num} 集`, duration: 60, status: 1 })),
  is_finished: true, is_original: 0,
});
const fixture = {
  calls: [] as { cmd: string; id?: number; ep?: number; page?: number }[],
  setIds: (_ids: number[]) => {}, setActive: (_active: boolean) => {}, setMounted: (_mounted: boolean) => {},
  preferences: null as ReturnType<typeof useContentPreferences> | null,
  history: [] as { id: number; ep: number; t: number; dur: number }[], back: 0, nearEnd: 0,
  complete(id: number, tags?: string[], error = "", empty = false) {
    const requests = pending.filter(request => request.id === id);
    if (!requests.length) throw new Error(`No pending detail ${id}`);
    requests.forEach(request => {
      pending.splice(pending.indexOf(request), 1);
      if (error) request.reject(new Error(error));
      else request.resolve(empty ? null as unknown as Detail : detail(id, tags));
    });
  },
};
Object.assign(window, { tagFeedFixture: fixture, __TAURI_INTERNALS__: {
  invoke: async () => null,
} });
api.boot = async () => ({ user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true });
api.video = id => {
  fixture.calls.push({ cmd: "detail", id });
  if (params.has("auto")) return Promise.resolve(detail(id, params.get("auto") === "block" ? ["Science"] : params.get("auto") === "long" ? ["L".repeat(65)] : ["Science", "science", "Travel"]));
  return new Promise((resolve, reject) => pending.push({ id, resolve, reject }));
};
api.play = async (id, ep) => {
  fixture.calls.push({ cmd: "play", id, ep });
  return { id, ep_num: ep, title: "自然观察", duration: 60,
    video_url: `http://127.0.0.1:17650/seg?u=${encodeURIComponent(`https://fixture.invalid/media/${id}/${ep}`)}` };
};
api.related = async id => { fixture.calls.push({ cmd: "related", id }); return { items: [], pagination: { page: 1, pages: 1, size: 20, total: 0 } }; };
api.feed = async (page = 1) => {
  fixture.calls.push({ cmd: "feed", page });
  const items = params.get("home") === "mixed" ? [card(1), card(2, ["Travel"])]
    : [card(page * 10 + 1, params.get("home") === "listed" ? ["Science"] : undefined)];
  return { items, pagination: { page, pages: params.get("home") === "mixed" ? 1 : 20, total: 20, size: 1 } };
};
function Harness() {
  const [ids, setIds] = useState((params.get("ids") || "1").split(",").map(Number));
  const [active, setActive] = useState(true), [mounted, setMounted] = useState(true);
  const store = useStore();
  fixture.preferences = useContentPreferences();
  fixture.setIds = setIds; fixture.setActive = setActive; fixture.setMounted = setMounted;
  fixture.history = store.history;
  return <div className="plat-ios" style={{ position: "relative", width: "100%", height: "100dvh" }}>
    {mounted && (params.has("home") ? <Home active={active} bottomInset={0} />
      : <Feed videoIds={ids} startIndex={Number(params.get("start") || 0)} mode="context"
        title="自然观察" active={active} bottomInset={0} onNearEnd={() => { fixture.nearEnd++; }} onBack={() => { fixture.back++; }} />)}
  </div>;
}
createRoot(document.getElementById("root")!).render(<AppProvider><Harness /></AppProvider>);
