"use client";

import { CoverImage } from "@/components/storefront/cover-image";
import type { Storefront } from "@/lib/storefront";
import type { PostDetail } from "@/lib/blog-api";
import type { StorefrontNavLink } from "@/lib/storefront-api";
import { storeTokens, tokenStyle } from "@/lib/theme-tokens";
import { StorefrontChrome } from "@/components/storefront/storefront-chrome";

type BodyBlock =
  | { kind: "h2"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "p"; text: string };

/**
 * The post body's minimal-markup convention: paragraphs separated by a blank
 * line, plus — since the 2026-09-07 blog-writer change — a line starting with
 * "## " as a subheading and consecutive "- " lines as one bullet list. Nothing
 * else is interpreted, so there's still no HTML to sanitize; a body written
 * before the change (plain paragraphs) renders exactly as it did.
 */
function parseBody(body: string): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ kind: "ul", items: list });
    list = [];
  };
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    if (line.startsWith("## ")) {
      flushPara();
      flushList();
      blocks.push({ kind: "h2", text: line.slice(3).trim() });
      continue;
    }
    if (line.startsWith("- ")) {
      flushPara();
      list.push(line.slice(2).trim());
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

export function BlogPostView({
  store,
  navLinks,
  post,
  basePath,
  previewMode,
}: {
  store: Storefront;
  navLinks: StorefrontNavLink[];
  post: PostDetail;
  basePath: string;
  /** See StorefrontChrome — set inside the Store Builder's preview. */
  previewMode?: boolean;
}) {
  const t = storeTokens(store.theme, store.plan.brandColors);
  const surface = "color-mix(in srgb, var(--ink) 4%, var(--bg))";
  const blocks = parseBody(post.body);

  return (
    <div
      className="min-h-screen"
      style={{ ...tokenStyle(t), background: "var(--bg)", color: "var(--ink)", fontFamily: "var(--font-body)" }}
    >
      <StorefrontChrome store={store} navLinks={navLinks} basePath={basePath} previewMode={previewMode}>
        <article className="mx-auto max-w-2xl px-6 py-14 sm:py-20">
          <a
            href={`${basePath}/blog`}
            className="mb-8 inline-block text-xs font-semibold uppercase opacity-60 hover:opacity-100"
            style={{ letterSpacing: "0.08em" }}
          >
            ← Back to journal
          </a>
          <p className="text-xs uppercase opacity-50" style={{ letterSpacing: "0.08em" }}>
            {new Date(post.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
          </p>
          <h1
            className="mt-2 text-3xl font-semibold"
            style={{ fontFamily: "var(--font-heading)", letterSpacing: "-0.01em" }}
          >
            {post.title}
          </h1>

          {post.coverImage && (
            <div className="relative mt-8 aspect-[16/9] overflow-hidden" style={{ background: surface, borderRadius: "var(--radius)" }}>
              <CoverImage src={post.coverImage} alt="" fill sizes="(min-width: 640px) 672px, 100vw" className="object-cover" priority />
            </div>
          )}

          <div className="mt-8 flex flex-col gap-5 text-base leading-relaxed opacity-85">
            {blocks.map((b, i) =>
              b.kind === "h2" ? (
                <h2
                  key={i}
                  className="mt-3 text-xl font-semibold"
                  style={{ fontFamily: "var(--font-heading)", letterSpacing: "-0.01em" }}
                >
                  {b.text}
                </h2>
              ) : b.kind === "ul" ? (
                <ul key={i} className="flex list-disc flex-col gap-2 pl-6">
                  {b.items.map((item, j) => (
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p key={i}>{b.text}</p>
              ),
            )}
          </div>
        </article>
      </StorefrontChrome>
    </div>
  );
}
