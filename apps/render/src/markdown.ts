// Rendered HTML → clean markdown. Readability (Mozilla) picks the article; when it finds nothing,
// the whole body is converted instead. Links and images are made absolute against the final URL.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const DROP = ["script", "style", "noscript", "template", "iframe", "object", "embed", "canvas", "svg", "form", "button", "input", "select", "textarea", "link", "meta"];

function turndown(): TurndownService {
  const t = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
  t.remove(DROP as (keyof HTMLElementTagNameMap)[]);
  return t;
}

function load(html: string, baseUrl: string) {
  const { document } = parseHTML(html);
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (/^\s*javascript:/i.test(href)) {
      a.removeAttribute("href");
      continue;
    }
    try {
      a.setAttribute("href", new URL(href, baseUrl).href);
    } catch {
      a.removeAttribute("href");
    }
  }
  for (const img of document.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? img.getAttribute("data-src") ?? "";
    img.removeAttribute("srcset");
    if (!src || /^data:/i.test(src)) {
      img.remove();
      continue;
    }
    try {
      img.setAttribute("src", new URL(src, baseUrl).href);
    } catch {
      img.remove();
    }
  }
  return document;
}

function tidy(md: string): string {
  return md
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type Extracted = { title: string; markdown: string; via: "readability" | "body" };

/** Converts a rendered page (its serialized DOM) to markdown. */
export function htmlToMarkdown(html: string, baseUrl: string): Extracted {
  const doc = load(html, baseUrl);
  const docTitle = (doc.querySelector("title")?.textContent ?? "").trim();
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(doc as unknown as Document, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }
  if (article?.content && (article.textContent ?? "").trim().length > 0) {
    const md = tidy(turndown().turndown(article.content));
    const title = (article.title ?? "").trim() || docTitle;
    // Readability drops the heading that repeats the title: put it back as the document's H1
    const head = title && !md.startsWith("# ") ? `# ${title.replace(/\s+/g, " ")}\n\n` : "";
    if (md.length > 0) return { title, markdown: `${head}${md}`, via: "readability" };
  }
  // Readability mutates the document: start again from the HTML for the whole-body fallback
  const body = load(html, baseUrl).querySelector("body");
  const md = body ? tidy(turndown().turndown(body.innerHTML)) : "";
  return { title: docTitle, markdown: md, via: "body" };
}

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // step back over continuation bytes (10xxxxxx) to a character boundary
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}
