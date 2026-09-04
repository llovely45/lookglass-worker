import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const seedPath = fileURLToPath(
  new URL("../migrations/0003_seed_navigation_links.sql", import.meta.url),
);

const expectedPanels = [
  "开发工具",
  "代理工具",
  "人工智能",
  "设计资源",
  "云服务",
  "18+",
];

const expectedLinks = [
  "https://www.spaceship.com",
  "https://dash.cloudflare.com",
  "https://github.com",
  "https://react.dev",
  "https://home.console.aliyun.com",
  "https://console-intl.huaweicloud.com/dns",
  "https://test.ustc.edu.cn",
  "https://fast.com",
  "https://fiber.google.com/speedtest",
  "https://www.speedtest.net",
  "https://github.com/ACL4SSR/ACL4SSR/tree/master",
  "https://ipcheck.lin8177.top/liu2040",
  "https://check.lin8177.top",
  "https://sub.942040.xyz",
  "https://s2v.lin8177.dpdns.org",
  "https://omnitt.com",
  "https://github.com/alireza0/s-ui",
  "https://github.com/yonggekkk/x-ui-yg",
  "https://github.com/bin456789/reinstall",
  "https://github.com/LOWERTOP/Shadowrocket-First",
  "https://yunwu.ai/",
  "https://stephecurry.asia",
  "https://chat.openai.com",
  "https://gemini.google.com",
  "https://tailwindcss.com",
  "https://fontawesome.com.cn/v5",
  "https://replit.com/repls",
  "https://www.starvm.cn/",
  "https://www.colocrossing.com",
  "https://www.racknerd.com",
  "https://yunyoo.cc",
  "https://www.lxc.wiki",
  "https://bytevirt.com",
  "https://akile.io",
  "https://acck.io",
  "https://glsnote.org",
  "https://hanime1.me",
  "https://aabook.xyz",
];

describe("navigation link seed migration", () => {
  it("seeds every non-excluded source category and link", () => {
    const exists = existsSync(seedPath);
    const sql = exists ? readFileSync(seedPath, "utf8") : "";

    expect(exists).toBe(true);
    expect(sql).toMatch(/INSERT\s+OR\s+IGNORE\s+INTO\s+panels/i);
    expect(sql).toMatch(/INSERT\s+OR\s+IGNORE\s+INTO\s+monitors/i);

    for (const panel of expectedPanels) {
      expect(sql).toContain(`'${panel}'`);
    }

    for (const link of expectedLinks) {
      expect(sql).toContain(`'${link}'`);
    }

    expect((sql.match(/nav-[a-z0-9-]+/g) ?? []).length).toBeGreaterThanOrEqual(
      expectedPanels.length + expectedLinks.length,
    );
    expect(sql).not.toContain("Linの相关");
    expect(sql).not.toContain("休闲娱乐");
    expect(sql).not.toContain("软件推荐");
    expect(sql).not.toContain("yuque.com/u25332524/ftq4u7");
    expect(sql).not.toContain("BluePointLilac/ContextMenuManager");
    expect(sql).not.toContain("blog.lin8177.top");
  });
});
