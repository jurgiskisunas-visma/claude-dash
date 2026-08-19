import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders assistant / user prose as Markdown, which is what Claude actually writes.
 *
 * One wrinkle: react-markdown drops raw HTML rather than rendering it (good — no
 * `dangerouslySetInnerHTML` anywhere), but transcripts are full of angle-bracket content
 * that is *not* HTML: `<task-notification>`, `<result>…`, generics like `List<string>`.
 * Left alone those get silently swallowed. So `<` is escaped to an entity everywhere except
 * inside code spans and fences, where entities would show up literally.
 */
function escapeAngleBracketsOutsideCode(src: string): string {
  // Keep fenced blocks and inline code spans intact; escape `<` in everything else.
  return src
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((chunk, i) => (i % 2 === 1 ? chunk : chunk.replace(/</g, "&lt;")))
    .join("");
}

export function Markdown({ children }: { children: string }) {
  const source = useMemo(() => escapeAngleBracketsOutsideCode(children), [children]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links open outside the dashboard; it isn't a browser.
          a: ({ node, ...props }) => {
            void node;
            return <a {...props} target="_blank" rel="noreferrer" />;
          },
          // Wide tables and code scroll inside themselves rather than stretching the pane.
          table: ({ node, ...props }) => {
            void node;
            return (
              <div className="md-scroll">
                <table {...props} />
              </div>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
