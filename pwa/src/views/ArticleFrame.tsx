// One dictionary article in its own iframe (src/frame/article.ts).
import { useEffect, useRef, useState } from "preact/hooks";
import { getLocale } from "../i18n";
import { articleDocument, frameSrc, linkAction, parseFrameMessage, sandboxFor } from "../frame/article";
import { playAudio } from "../lib/audio";
import { fontScale, getFontPref } from "../lib/font";
import { effectiveTheme } from "../lib/theme";

export interface ArticleFrameProps {
  body: string;
  /** The dictionary is trusted_render: same-origin rendering (style A). */
  trusted: boolean;
  title: string;
  /** A cross-reference (entry://) was followed. */
  onLookup: (word: string) => void;
}

export function ArticleFrame({ body, trusted, title, onLookup }: ArticleFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(48);
  const lookup = useRef(onLookup);
  lookup.current = onLookup;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    // The article is sent once: if the frame later navigated itself elsewhere and asked again, the
    // article (and its signed URLs) would go to that page.
    let rendered = false;
    const expectedOrigin = trusted ? location.origin : "null";
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== expectedOrigin) return;
      const msg = parseFrameMessage(e.data);
      if (!msg) return;
      switch (msg.type) {
        case "ready":
          if (rendered) return;
          rendered = true;
          frame.contentWindow?.postMessage(
            { type: "pxdict:render", html: articleDocument({ body, theme: effectiveTheme(), lang: getLocale(), fontScale: fontScale[getFontPref()] }) },
            // An opaque origin can only be addressed as "*"; e.source was checked above.
            trusted ? location.origin : "*",
          );
          break;
        case "height":
          setHeight(msg.height);
          break;
        case "link": {
          const action = linkAction(msg.href);
          if (action.kind === "lookup") lookup.current(action.word);
          else if (action.kind === "audio") playAudio(action.url);
          else if (action.kind === "external") window.open(action.url, "_blank", "noopener,noreferrer");
          break;
        }
      }
    };
    addEventListener("message", onMessage);
    return () => {
      removeEventListener("message", onMessage);
    };
  }, [body, trusted]);

  return (
    <iframe
      ref={ref}
      class="article"
      src={frameSrc}
      sandbox={sandboxFor(trusted)}
      title={title}
      referrerpolicy="no-referrer"
      style={{ height: `${String(height)}px` }}
    />
  );
}
