import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TopicsPage, TopicPage, TagsPage, TagPage } from "../src/pages/Discover";
import Category, { ChannelPage } from "../src/pages/Category";
import { AppProvider } from "../src/store";
import "../src/index.css";

type Args = Record<string, unknown>;
const pending: { cmd: string; args: Args; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
const fixture = {
  calls: [] as { cmd: string; args: Args }[],
  setKey: (_key: string) => {},
  complete(cmd: string, data: unknown, error = false, match: Args = {}) {
    const i = pending.findIndex(r => r.cmd === cmd && Object.entries(match).every(([k, v]) => r.args[k] === v));
    if (i < 0) throw new Error(`No pending ${cmd} ${JSON.stringify(match)}`);
    const [request] = pending.splice(i, 1);
    if (error) request.reject(data); else request.resolve(data);
  },
};
Object.assign(window, { discoverFixture: fixture, __TAURI_INTERNALS__: { invoke(cmd: string, args: Args = {}) {
  if (cmd === "app_boot") return Promise.resolve({ user: null, strict_security: true });
  if (cmd === "playback_log_status") return Promise.resolve({ enabled: false });
  if (cmd === "debug_log") return Promise.resolve();
  fixture.calls.push({ cmd, args });
  return new Promise((resolve, reject) => pending.push({ cmd, args, resolve, reject }));
} } });
function Harness() {
  const [key, setKey] = useState("first");
  fixture.setKey = setKey;
  const page = new URLSearchParams(location.search).get("page");
  const wide = innerWidth > 640;
  return <div className="plat-ios" style={{ position: "relative", width: "100%", height: "100dvh" }}>
    {page === "topic" ? <TopicPage slug={key} name={key} wide={wide} onBack={() => {}} />
      : page === "tags" ? <TagsPage wide={wide} onBack={() => {}} />
      : page === "tag" ? <TagPage tag={key} name={key} wide={wide} onBack={() => {}} />
      : page === "channel" ? <ChannelPage cate="ai-duanju" name="测试频道" wide={wide} onBack={() => {}} />
      : page === "category" ? <Category active wide={wide} />
      : <TopicsPage wide={wide} onBack={() => {}} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<AppProvider><Harness /></AppProvider>);
