import { useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { AppProvider } from "../src/store";
import { ArticlePanel, CommentsPanel, EpisodesPanel } from "../src/components/Panels";
import Feed from "../src/components/Feed";
import "../src/index.css";
type Pending = { cmd: string; args: Record<string, unknown>; resolve: (v: any) => void; reject: (v: unknown) => void };
const pending: Pending[] = [];
const fixture = {
  calls: [] as { cmd: string; args: Record<string, unknown> }[], copied: [] as string[],
  setEp: (_ep: number) => {}, setActive: (_active: boolean) => {},
  complete(cmd: string, value: unknown, error = false, match: Record<string, unknown> = {}) {
    const i = pending.findIndex(r => r.cmd === cmd && Object.entries(match).every(([k,v]) => r.args[k] === v));
    if (i < 0) throw Error(`No pending ${cmd}`);
    const [r] = pending.splice(i, 1); if (error) r.reject(new Error(String(value))); else r.resolve(value);
  },
};
const request = (cmd: string, args: Record<string, unknown>) => {
  fixture.calls.push({ cmd, args });
  return new Promise<any>((resolve, reject) => pending.push({ cmd, args, resolve, reject }));
};
Object.assign(window, { playerPanelFixture: fixture });
Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { fixture.copied.push(text); } } });
const params = new URLSearchParams(location.search);
api.boot = async () => ({ base: "https://fixture.invalid", logged_in: !params.has("guest"), user: params.has("guest") ? null : { id: 7, username: "fixture", nickname: "测试用户", avatar: "", avatar_color: "" } });
api.comments = (id, ep, page = 1) => request("comments", { id, ep, page });
api.postComments = (id, page) => request("posts", { id, page });
api.commentSend = (id, ep, text) => request("send", { id, ep, text });
api.openUrl = async () => { throw Error("external handler unavailable"); };
api.video = async () => ({ id: 991, title: "中性测试影片", description: "影片介绍。".repeat(100), cover: "", tags: [], score: 8, episode_count: 30, total_episodes: 30, episodes: Array.from({length:30}, (_,i) => ({ep_num:i+1,title:`第 ${i+1} 集`,duration:90,status:1})), counts:{like:0,collect:0,comment:0,hot:0},author:{id:1,name:"测试作者"},is_finished:true,is_original:0 });
api.play = async (id, ep) => { fixture.calls.push({ cmd: "play", args: { id, ep } }); return { id, ep_num: ep, title: "测试", duration: 90, video_url: "" }; };
function Harness() {
  const [ep, setEp] = useState(1), [active, setActive] = useState(true);
  fixture.setEp = setEp; fixture.setActive = setActive;
  return <><div className="plat-ios" style={{ position: "relative", width: "100%", height: "min(72vh, 620px)" }}>
    {params.get("page") === "episodes" ? <EpisodesPanel videoId={991} episodes={Array.from({length:30}, (_,i) => ({ep_num:i+1,title:`第 ${i+1} 集`,duration:90,status:1}))} current={ep} onPick={setEp} onClose={() => {}} />
      : params.get("page") === "article" ? <ArticlePanel title="详情测试" html={`${"<p>正文内容用于验证独立滚动。</p>".repeat(40)}<a href="https://example.com/article">正文链接</a>`} onClose={() => {}} />
      : params.get("page") === "feed" ? <Feed videoIds={[991]} mode="context" active={active} bottomInset={0} />
      : <CommentsPanel videoId={991} ep={ep} total={40} onClose={() => {}} />}
  </div><button id="outside">播放器外部按钮</button></>;
}
createRoot(document.getElementById("root")!).render(<AppProvider><Harness /></AppProvider>);
