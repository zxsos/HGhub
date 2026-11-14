import { useState } from "react";
import { createRoot } from "react-dom/client";
import Profile from "../src/pages/Profile";
import { FollowingPage, UserPage } from "../src/pages/User";
import { AppProvider, useStore } from "../src/store";
import LoginModal from "../src/components/LoginModal";
import { ToastHost } from "../src/components/ui";
import type { User } from "../src/types";
import "../src/index.css";

type Pending = { cmd: string; args: Record<string, unknown>; resolve: (v: unknown) => void; reject: (v: string) => void };
const query = new URLSearchParams(location.search);
const scenario = query.get("scenario") || "profile-error";
const demoUser = { id: 9, username: "fixture", nickname: "测试账户", counts: {} } as User;
const card = (id: number) => ({ id, title: `作品 ${id}`, cover: "", description: "", tags: ["测试"], score: 8.5,
  episode_count: 10, total_episodes: 10, is_finished: true, is_original: 0, hot: 100,
  counts: {}, author: { id: 7, name: "测试作者" }, episodes: [], like_count: 0, collect_count: 0, comment_count: 0 });
const pageOf = (page: number) => ({ items: Array.from({ length: 20 }, (_, i) => card((page - 1) * 20 + i + 1)),
  pagination: { page, pages: 2, size: 20, total: 40 } });
localStorage.setItem("hghubx_theme", query.get("theme") || "light");
localStorage.setItem("hghubx_swipe_ep_v2", "1");
localStorage.setItem("hghubx_app_v1", JSON.stringify({
  favs: scenario === "profile-many" ? Array.from({ length: 17 }, (_, i) => i + 1) : [1, 2, 3],
  history: [4, 5].map(id => ({ id, ep: 1, t: 10, dur: 100, at: 123 })), follows: [],
}));
const pending: Pending[] = [];
const fixture = {
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  faults: new Set(scenario === "profile-error" ? ["api_video"] : scenario === "profile-partial" ? ["video:2"] : scenario === "user-errors" ? ["api_user", "api_user_stats"] : []),
  held: new Set(scenario === "profile-pending" ? ["api_video"] : []),
  loggedIn: scenario === "profile-logout" || scenario === "user-errors" || scenario === "user-follow" || scenario === "following-paging",
  setUser: (_u: User | null) => {},
  navigate: (_page: string, _id?: number) => {},
  state: {} as { user: User | null; follows: number[]; history: unknown[]; loginOpen: boolean },
  login() { fixture.setUser(demoUser); },
  settle(cmd: string, ok = true) {
    const matching = pending.filter(p => p.cmd === cmd);
    for (const p of matching) {
      pending.splice(pending.indexOf(p), 1);
      if (ok) p.resolve(result(cmd, p.args)); else p.reject("HTTP 503 Fixture failure");
    }
  },
};
function result(cmd: string, args: Record<string, unknown>) {
  if (cmd === "api_video") return card(Number(args.id));
  if (cmd === "api_user") return { id: Number(args.id), username: "author", nickname: `作者 ${args.id}`, sign: "这是较长的作者签名。".repeat(30) };
  if (cmd === "api_user_stats") return { followers: 120, video_count: 40, like_count: 20 };
  if (cmd === "api_following" || cmd === "api_user_videos") return pageOf(Number(args.page));
  return { ok: true };
}
Object.assign(window, { accountRecoveryFixture: fixture, __TAURI_INTERNALS__: {
  invoke(cmd: string, args: Record<string, unknown> = {}) {
    if (cmd === "app_boot") return Promise.resolve({ user: fixture.loggedIn ? demoUser : null, strict_security: true, base: "https://fixture.invalid" });
    if (cmd === "debug_log" || cmd === "playback_log_status") return Promise.resolve(null);
    fixture.calls.push({ cmd, args });
    if (fixture.held.has(cmd)) return new Promise((resolve, reject) => pending.push({ cmd, args, resolve, reject }));
    if (fixture.faults.has(cmd) || (cmd === "api_video" && fixture.faults.has(`video:${args.id}`))) return Promise.reject("HTTP 503 Fixture failure");
    return Promise.resolve(result(cmd, args));
  },
} });
function Harness() {
  const store = useStore();
  const [page, setPage] = useState(scenario.startsWith("following") ? "following" : scenario.startsWith("user") ? "user" : "profile");
  const [id, setId] = useState(7);
  fixture.setUser = store.setUser;
  fixture.state = { user: store.user, follows: store.follows, history: store.history, loginOpen: store.loginOpen };
  fixture.navigate = (next, nextId) => { setPage(next); if (nextId) setId(nextId); };
  return <div className="plat-ios" style={{ position: "absolute", inset: 0 }}>
    {page === "profile" ? <Profile wide={innerWidth > 640} /> : page === "following" ? <FollowingPage wide={innerWidth > 640} onBack={() => setPage("profile")} /> : page === "user" ? <UserPage id={id} wide={innerWidth > 640} onBack={() => setPage("profile")} /> : null}
    <LoginModal /><ToastHost />
  </div>;
}
createRoot(document.getElementById("root")!).render(<AppProvider><Harness /></AppProvider>);
