import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/store";
import { useContentPreferences } from "../src/contentPreferences";
import { Masonry } from "../src/components/cards";
import { InplaceSearch } from "../src/components/InplaceSearch";
import Search, { RankPage } from "../src/pages/Search";
import Category, { ChannelPage } from "../src/pages/Category";
import { TopicPage, TagPage } from "../src/pages/Discover";
import { FollowingPage, UserPage } from "../src/pages/User";
import Profile from "../src/pages/Profile";
import type { VideoCard } from "../src/types";
import "../src/index.css";

type Args = Record<string, unknown>;
const query = new URLSearchParams(location.search);
const screen = query.get("screen") || "masonry";
const fixtureOrigin = "https://fixture.invalid";
const loggedIn = screen === "following";
const fixtureUser = { id: 9, nickname: "测试账户", username: "fixture" };
const allBlocked = query.get("data") === "all";
const pages = Number(query.get("pages") || 1);
const card = (id: number, tags: string[]): VideoCard => ({ id, title: id === 1 ? "精确屏蔽标题" : `可见标题 ${id}`, cover: `https://fixture.invalid/${id === 1 ? "blocked-cover" : `cover-${id}`}.png`, tags, score: 8,
  episode_count: 2, total_episodes: 2, is_finished: true, is_original: 1, hot: 100, like_count: 1, collect_count: 1, comment_count: 1 });
const cards = allBlocked ? [card(1, ["foo"]), card(2, ["FOO"])]
  : [card(1, ["  FoO  "]), card(2, ["foobar"]), card(3, ["foo!"]), card(4, [])];
const pageOf = (page: number) => ({ items: page === 1 ? cards : [card(10 + page, ["allowed"])], pagination: { page, pages, size: 20, total: 40 } });
const pending: { cmd: string; args: Args; resolve: (value: unknown) => void }[] = [];
const fixture = {
  calls: [] as { cmd: string; args: Args }[], held: new Set<string>(), setScope: (_value: string) => {},
  preferences: {} as ReturnType<typeof useContentPreferences>, state: {} as ReturnType<typeof useStore>,
  settle() { for (const request of pending.splice(0)) request.resolve(result(request.cmd, request.args)); },
};
function result(cmd: string, args: Args) {
  if (cmd === "api_me") return { user: fixtureUser, origin: fixtureOrigin, interactions: { favorite_video_ids: [1, 2], like_video_ids: [], follow_user_ids: [7], like_video_episodes: [] } };
  if (cmd === "api_account_history") return { items: [], pagination: { page: 1, pages: 0, size: 100, total: 0 } };
  if (["api_category", "api_original_videos", "api_post_category", "api_search", "api_tag_videos", "api_following", "api_user_videos"].includes(cmd)) return { ...pageOf(Number(args.page)), keyword: args.q };
  if (cmd === "api_rank") return { type: args.kind, items: cards.map((item, i) => ({ ...item, rank: i + 1, video_id: item.id, metric_value: 100, metric_label: "热度" })) };
  if (cmd === "api_topic") return { topic: { id: 1, title: "专题 fixture", intro: "专题介绍", cover: "", slug: args.slug }, related: [], videos: pageOf(1) };
  if (cmd === "api_video") return { ...cards.find(item => item.id === Number(args.id)), counts: {}, episodes: [] };
  if (cmd === "api_user") return { id: args.id, nickname: "测试作者", username: "fixture" };
  if (cmd === "api_user_stats") return { video_count: 40, followers: 2, like_count: 3 };
  if (cmd === "api_search_hot") return { items: [{ video_id: 1, title: "热搜无标签", plays: "100" }] };
  return null;
}
Object.assign(window, { contentFilterFixture: fixture, __TAURI_INTERNALS__: { invoke(cmd: string, args: Args = {}) {
  // Profile verifies retained guest records; only the following screen requires an account.
  if (cmd === "app_boot") return Promise.resolve({ user: loggedIn ? fixtureUser : null, logged_in: loggedIn, base: fixtureOrigin, strict_security: true });
  if (cmd === "debug_log" || cmd === "playback_log_status") return Promise.resolve(null);
  fixture.calls.push({ cmd, args });
  return fixture.held.has(cmd) ? new Promise(resolve => pending.push({ cmd, args, resolve })) : Promise.resolve(result(cmd, args));
} } });
function Harness() {
  const [scope, setScope] = useState("first");
  fixture.setScope = setScope;
  fixture.preferences = useContentPreferences();
  fixture.state = useStore();
  const wide = innerWidth > 640;
  return <div className="plat-ios" style={{ position: "relative", height: "100dvh", width: "100%" }}>
    {screen === "search" ? <Search active wide={wide} />
      : screen === "rank" ? <RankPage onBack={() => {}} wide={wide} />
      : screen === "inplace-video" || screen === "inplace-post" ? <InplaceSearch kind={screen === "inplace-post" ? "post" : "video"} wide={wide} onClose={() => {}} />
      : screen === "category" ? <Category active wide={wide} />
      : screen === "channel" ? <ChannelPage cate="ai-duanju" name="测试频道" onBack={() => {}} wide={wide} />
      : screen === "topic" ? <TopicPage slug={scope} name="测试专题" onBack={() => {}} wide={wide} />
      : screen === "tag" ? <TagPage tag={`${scope}-slug`} name="foo" onBack={() => {}} wide={wide} />
      : screen === "following" ? <FollowingPage onBack={() => {}} wide={wide} />
      : screen === "user" ? <UserPage id={scope === "first" ? 7 : 8} onBack={() => {}} wide={wide} />
      : screen === "profile" ? <Profile wide={wide} />
      : <div className="p-4"><Masonry videos={cards} scopeKey={scope} wide={wide} onOpen={() => {}} /></div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<AppProvider><Harness /></AppProvider>);
