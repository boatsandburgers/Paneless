import { useState } from "react";
import { navigateToHeading, type Heading } from "./types";
export default function Outline({
  headings,
  close,
  loaded,
}: {
  headings: Heading[];
  close: () => void;
  loaded: boolean;
}) {
  const [scroll, setScroll] = useState(0);
  const [query, setQuery] = useState("");
  const filtered = query
    ? headings.filter((h) => h.text.toLowerCase().includes(query.toLowerCase()))
    : headings;
  const start = Math.max(0, Math.floor(scroll / 34) - 5);
  const visible = filtered.slice(start, start + 40);
  return (
    <aside className="outline" aria-label="Document outline">
      <div className="outline-title">
        ON THIS PAGE
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close outline"
        >
          ×
        </button>
      </div>
      <input
        className="outline-filter"
        aria-label="Filter headings"
        placeholder="Find a heading…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setScroll(0);
          e.currentTarget.parentElement!.querySelector(
            ".outline-scroll",
          )!.scrollTop = 0;
        }}
      />
      <div
        className="outline-scroll"
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      >
        <div style={{ height: filtered.length * 34, position: "relative" }}>
          {visible.map((h, i) => (
            <button
              key={h.id}
              className="outline-item"
              style={{
                top: (start + i) * 34,
                paddingLeft: 14 + (h.level - 1) * 12,
              }}
              title={h.text}
              onClick={() => {
                navigateToHeading(h.id);
                if (window.innerWidth < 760) close();
              }}
            >
              {h.text}
            </button>
          ))}
        </div>
      </div>
      <div className="outline-foot">
        {headings.length.toLocaleString()} headings
        {!loaded && " · Loading document…"}
      </div>
    </aside>
  );
}
