import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Settings from "../src/pages/Settings";
import { AppProvider } from "../src/store";
import { blockReason, CONTENT_PREFERENCES_KEY, MAX_BLOCKED_TAGS, MAX_TAG_LENGTH, normalizeTag, useContentPreferences } from "../src/contentPreferences";
import "../src/index.css";
function Probe({ name }: { name: string }) {
  const state = useContentPreferences();
  if (name === "first") Object.assign(window, { preferenceFixture: { ...state, key: CONTENT_PREFERENCES_KEY, normalizeTag, reason: blockReason, maxTags: MAX_BLOCKED_TAGS, maxLength: MAX_TAG_LENGTH } });
  return <output data-probe={name}>{JSON.stringify(state.preferences)}</output>;
}
function Harness() {
  const [wide, setWide] = useState(innerWidth > 640);
  useEffect(() => {
    const resize = () => setWide(innerWidth > 640);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return <><div hidden><Probe name="first" /><Probe name="second" /></div>
    <div className="plat-ios absolute inset-0"><Settings wide={wide} onBack={() => {}} /></div></>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><AppProvider><Harness /></AppProvider></React.StrictMode>);
