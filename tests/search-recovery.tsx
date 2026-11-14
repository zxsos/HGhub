import { createRoot } from "react-dom/client";
import Search, { RankPage } from "../src/pages/Search";
import { InplaceSearch } from "../src/components/InplaceSearch";
import { AppProvider } from "../src/store";
import "../src/index.css";

const params = new URLSearchParams(location.search);
const page = params.get("page");
createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <div className="plat-ios" style={{ position: "relative", height: "100dvh" }}>
      {page === "rank" ? <RankPage onBack={() => {}} wide={innerWidth > 640} />
        : page === "inplace" || page === "original" ? <InplaceSearch kind="video" scope={page === "original" ? "original" : undefined} onClose={() => {}} wide={innerWidth > 640} />
        : <Search active wide={innerWidth > 640} />}
    </div>
  </AppProvider>,
);
