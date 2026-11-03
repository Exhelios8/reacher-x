import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import mdx from "@mdx-js/rollup";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import remarkBlogCode from "./features/blog/lib/remarkBlogCode.mjs";
import rehypeBlogTaskLists from "./features/blog/lib/rehypeBlogTaskLists.mjs";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";

export default defineConfig({
  plugins: [
    mdx({
      providerImportSource: "@/mdx-components",
      remarkPlugins: [remarkFrontmatter, remarkGfm, remarkBlogCode],
      rehypePlugins: [rehypeSlug, rehypeBlogTaskLists],
    }),
    vinext({ cache: { data: kvDataAdapter() } }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
