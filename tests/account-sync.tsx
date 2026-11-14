import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/store";
import Profile from "../src/pages/Profile";
import Feed from "../src/components/Feed";
import LoginModal from "../src/components/LoginModal";
import { ToastHost } from "../src/components/ui";
import type { User } from "../src/types";
import "../src/index.css";

type Args = Record<string, unknown>;
type Interactions = { favorite_video_ids?: number[]; like_video_ids?: number[]; follow_user_ids?: number[]; favorite_post_ids?: number[]; like_post_ids?: number[]; like_video_episodes?: { video_id: number; ep: number }[] };
type HistoryRow = { id: number; video_id: number; last_ep: number; updated_at: string; target_type: "video" };
type Account = { user: User; interactions: Interactions; history: HistoryRow[] };
type Pending = { cmd: string; args: Args; snapshot: unknown; resolve: (value: unknown) => void; reject: (error: string) => void };
const query = new URLSearchParams(location.search);
const originA = "https://account-fixture.invalid";
const originB = "https://second-fixture.invalid";
const user = (id: number) => ({ id, username: `account${id}`, nickname: `测试账号 ${id}`, avatar: "", avatar_color: "#62758a", counts: {} }) as User;
const history = (id: number, video_id: number, last_ep = 1): HistoryRow => ({ id, video_id, last_ep, updated_at: "2026-11-14T12:00:00Z", target_type: "video" });
const accounts: Record<number, Account> = {
  11: { user: user(11), interactions: { favorite_video_ids: [101, 102], like_video_ids: [101], follow_user_ids: [701], favorite_post_ids: [101], like_post_ids: [105], like_video_episodes: [{ video_id: 101, ep: 2 }] }, history: [history(9001, 201, 2), history(9002, 202), history(9003, 203, 3)] },
  22: { user: user(22), interactions: { favorite_video_ids: [301], like_video_ids: [], follow_user_ids: [702], favorite_post_ids: [], like_post_ids: [], like_video_episodes: [] }, history: [history(9101, 302, 4)] },
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const card = (id: number) => ({ id, title: `测试作品 ${id}`, cover: "", description: "离线账号同步测试", tags: ["测试"], score: 8,
  episode_count: 4, total_episodes: 4, is_finished: true, is_original: 0, hot: 20,
  counts: { collect: 4, like: 3, comment: 0 }, author: { id: 701, name: "测试作者" }, episodes: [{ ep: 1, num: 1, title: "第一集" }, { ep: 2, num: 2, title: "第二集" }] });
localStorage.clear();
localStorage.setItem("hghubx_theme", "light");
localStorage.setItem("hghubx_swipe_ep_v2", "1");
localStorage.setItem("hghubx_auto_line", "off");
localStorage.setItem("hghubx_app_v1", JSON.stringify({ favs: [901], likes: [902], follows: [903], history: [{ id: 904, ep: 1, t: 17, dur: 100, at: 1 }] }));
const pending: Pending[] = [];
let serverUser: number | null = query.get("boot") === "a" ? 11 : null;
let serverOrigin = originA;
let store: ReturnType<typeof useStore>;
let navigate: (page: string) => void = () => {};
const nativeSetItem = Storage.prototype.setItem;
const fixture = {
  originA, originB, accounts,
  calls: [] as { cmd: string; args: Args }[],
  held: new Set(query.has("holdBoot") ? ["app_boot"] : []), faults: new Set<string>(),
  emptyHistoryPages: new Set<number>(),
  outcomes: {} as Record<string, { status: string; error?: string }>, state: {} as Record<string, unknown>, ready: false,
  login(id: number, origin = originA) { serverUser = id; serverOrigin = origin; store.setUser(accounts[id].user, origin); },
  changeLine(id: number | null, origin: string) { serverUser = id; serverOrigin = origin; window.dispatchEvent(new Event("hg:line-changed")); },
  guest() { serverUser = null; store.setUser(null); },
  navigate(page: string) { navigate(page); },
  run(label: string, operation: string, args: unknown[] = []) {
    fixture.outcomes[label] = { status: "pending" };
    const methods = store as unknown as Record<string, (...args: unknown[]) => unknown>;
    Promise.resolve().then(() => methods[operation](...args)).then(() => { fixture.outcomes[label] = { status: "fulfilled" }; }, e => { fixture.outcomes[label] = { status: "rejected", error: e instanceof Error ? e.message : String(e) }; });
  },
  settle(cmd: string, ok = true, expectedUserId?: number) {
    for (const p of [...pending]) {
      if (p.cmd !== cmd || (expectedUserId !== undefined && p.args.expectedUserId !== expectedUserId)) continue;
      pending.splice(pending.indexOf(p), 1);
      if (!ok) p.reject("HTTP 503 Fixture request failure");
      else { try { p.resolve(isWrite(cmd) ? result(cmd, p.args) : p.snapshot); } catch (error) { p.reject(String(error)); } }
    }
  },
  pending: () => pending.map(p => ({ cmd: p.cmd, args: p.args })),
  inspect(id: number, ep = 1) { return { videoFav: store.isFav(id, "video"), postFav: store.isFav(id, "post"), videoLike: store.isLiked(id, ep, "video"), postLike: store.isLiked(id, ep, "post") }; },
  addHistory(id: number, ep?: number, t?: number, dur?: number) { store.addHistory(id, ep, t, dur); },
  captureHistory() { const add = store.addHistory; fixture.savedHistory = id => add(id, 1, 20, 100); },
  savedHistory: undefined as undefined | ((id: number) => void),
  storageFault(enabled: boolean) {
    Storage.prototype.setItem = enabled ? function(this: Storage, key: string, value: string) {
      let accountCache = false;
      try { const parsed = JSON.parse(value); accountCache = parsed?.version === 1 && !!parsed.accounts; } catch { /* non-account storage */ }
      if (accountCache) throw new DOMException("Fixture storage is full", "QuotaExceededError");
      return nativeSetItem.call(this, key, value);
    } : nativeSetItem;
  },
};
const isWrite = (cmd: string) => ["api_collect", "api_like", "api_follow", "api_post_collect", "api_post_like", "api_account_history_record", "api_account_history_delete", "api_logout"].includes(cmd);
function result(cmd: string, args: Args): unknown {
  const id = Number(args.expectedUserId ?? serverUser);
  const account = accounts[id];
  if (cmd === "app_boot") return { user: serverUser ? accounts[serverUser].user : null, logged_in: !!serverUser, base: serverOrigin, strict_security: true };
  if (cmd === "api_me") return clone({ user: account.user, interactions: account.interactions, origin: args.expectedOrigin ?? serverOrigin });
  if (cmd === "api_login" || cmd === "api_register") { serverUser = 11; return { user: accounts[11].user, origin: serverOrigin }; }
  if (cmd === "api_logout") { serverUser = null; return { ok: true }; }
  if (cmd === "api_account_history") {
    const page = Number(args.page || 1), size = 2;
    return clone({ items: fixture.emptyHistoryPages.has(page) ? [] : account.history.slice((page - 1) * size, page * size), pagination: { page, pages: Math.ceil(account.history.length / size), size, total: account.history.length } });
  }
  if (cmd === "api_account_history_record") {
    const videoId = Number(args.videoId), ep = Number(args.ep);
    account.history = [history(10000 + videoId, videoId, ep), ...account.history.filter(row => row.video_id !== videoId)];
    return { ok: true };
  }
  if (cmd === "api_account_history_delete") { account.history = account.history.filter(row => !(args.ids as number[]).includes(row.id)); return { ok: true }; }
  const update = (field: "favorite_video_ids" | "like_video_ids" | "follow_user_ids" | "favorite_post_ids" | "like_post_ids", value: number) => {
    const values = account.interactions[field] || [];
    account.interactions[field] = args.on ? [value, ...values.filter(item => item !== value)] : values.filter(item => item !== value);
    return { ok: true };
  };
  if (cmd === "api_collect") return update("favorite_video_ids", Number(args.id));
  if (cmd === "api_post_collect") return update("favorite_post_ids", Number(args.id));
  if (cmd === "api_post_like") return update("like_post_ids", Number(args.id));
  if (cmd === "api_follow") return update("follow_user_ids", Number(args.uid));
  if (cmd === "api_like") {
    const current = (account.interactions.like_video_episodes || []).filter(item => item.video_id !== Number(args.id) || item.ep !== Number(args.ep));
    account.interactions.like_video_episodes = args.on ? [...current, { video_id: Number(args.id), ep: Number(args.ep) }] : current;
    return update("like_video_ids", Number(args.id));
  }
  if (cmd === "api_video") return card(Number(args.id));
  if (cmd === "api_play") return { id: args.id, ep_num: args.ep, duration: 120, video_url: "" };
  if (cmd === "api_related") return { items: [] };
  if (cmd === "api_comments") return { items: [], pagination: { page: 1, pages: 0, total: 0 } };
  if (cmd === "playback_log_status") return { enabled: false, path: "", text: "" };
  if (cmd === "line_state") return { base: serverOrigin, fixed: [] };
  if (cmd === "proxy_state") return { mode: "system", url: "", effective: null };
  return { ok: true };
}
Object.assign(window, { accountSyncFixture: fixture, __TAURI_INTERNALS__: {
  invoke(cmd: string, args: Args = {}) {
    fixture.calls.push({ cmd, args });
    if (fixture.held.has(cmd)) {
      const snapshot = isWrite(cmd) ? null : clone(result(cmd, args));
      return new Promise((resolve, reject) => pending.push({ cmd, args, snapshot, resolve, reject }));
    }
    if (fixture.faults.has(cmd) || fixture.faults.has(`${cmd}:${args.page}`)) return Promise.reject("HTTP 503 Fixture request failure");
    try { return Promise.resolve(result(cmd, args)); } catch (error) { return Promise.reject(String(error)); }
  },
} });
function Harness() {
  store = useStore();
  const [page, setPage] = useState(query.get("page") || "profile");
  navigate = setPage;
  fixture.ready = true;
  fixture.state = { user: store.user, scope: store.accountScope, sync: store.accountSync, favs: store.favs, likes: store.likes, follows: store.follows, history: store.history,
    pendingCollect: store.actionPending?.("collect:video:101"), pendingFollow: store.actionPending?.("follow:701") };
  return <div className="plat-ios" style={{ position: "absolute", inset: 0 }}>
    {page === "feed" ? <Feed videoIds={[101]} mode="context" active bottomInset={0} onBack={() => setPage("profile")} /> : <Profile wide={innerWidth > 640} />}
    <LoginModal /><ToastHost />
  </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><AppProvider><Harness /></AppProvider></StrictMode>);
