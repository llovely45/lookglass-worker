-- Seed the public navigation entries copied from https://home.lin8177.top/nav/.
-- The Lin-related, leisure, and software-recommendation categories are
-- intentionally excluded. INSERT OR IGNORE keeps this migration safe to
-- re-run in a local database without replacing existing configuration.

INSERT OR IGNORE INTO panels (
  id, name, logo_url, sort_order, enabled, created_at, updated_at
) VALUES
  ('nav-development-tools', '开发工具', NULL, 2, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-proxy-tools', '代理工具', NULL, 3, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-artificial-intelligence', '人工智能', NULL, 4, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-design-resources', '设计资源', NULL, 5, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-cloud-services', '云服务', NULL, 6, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-18-plus', '18+', NULL, 7, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER));

INSERT OR IGNORE INTO monitors (
  id, panel_id, name, logo_url, link_url, kind, target, port, sort_order,
  enabled, created_at, updated_at
) VALUES
  ('nav-spaceship', 'nav-development-tools', 'Spaceship', NULL, 'https://www.spaceship.com', 'http_get', 'https://www.spaceship.com', NULL, 0, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-cloudflare', 'nav-development-tools', 'Cloudflare', NULL, 'https://dash.cloudflare.com', 'http_get', 'https://dash.cloudflare.com', NULL, 1, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-github', 'nav-development-tools', 'GitHub', NULL, 'https://github.com', 'http_get', 'https://github.com', NULL, 2, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-react', 'nav-development-tools', 'React', NULL, 'https://react.dev', 'http_get', 'https://react.dev', NULL, 3, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-aliyun', 'nav-development-tools', '阿里云', NULL, 'https://home.console.aliyun.com', 'http_get', 'https://home.console.aliyun.com', NULL, 4, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-huaweicloud', 'nav-development-tools', '华为云国际版', NULL, 'https://console-intl.huaweicloud.com/dns', 'http_get', 'https://console-intl.huaweicloud.com/dns', NULL, 5, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),

  ('nav-ustc-speed', 'nav-proxy-tools', '中科大学测速站', NULL, 'https://test.ustc.edu.cn', 'http_get', 'https://test.ustc.edu.cn', NULL, 0, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-fast', 'nav-proxy-tools', 'Fast测速', NULL, 'https://fast.com', 'http_get', 'https://fast.com', NULL, 1, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-google-fiber', 'nav-proxy-tools', '谷歌测速', NULL, 'https://fiber.google.com/speedtest', 'http_get', 'https://fiber.google.com/speedtest', NULL, 2, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-speedtest', 'nav-proxy-tools', 'Speedtest', NULL, 'https://www.speedtest.net', 'http_get', 'https://www.speedtest.net', NULL, 3, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-acl4ssr', 'nav-proxy-tools', 'ACL4SSR规则', NULL, 'https://github.com/ACL4SSR/ACL4SSR/tree/master', 'http_get', 'https://github.com/ACL4SSR/ACL4SSR/tree/master', NULL, 4, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-ipcheck', 'nav-proxy-tools', '代理检测工具', NULL, 'https://ipcheck.lin8177.top/liu2040', 'http_get', 'https://ipcheck.lin8177.top/liu2040', NULL, 5, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-purity-check', 'nav-proxy-tools', '代理纯净度工具', NULL, 'https://check.lin8177.top', 'http_get', 'https://check.lin8177.top', NULL, 6, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-subscription', 'nav-proxy-tools', '优选订阅器', NULL, 'https://sub.942040.xyz', 'http_get', 'https://sub.942040.xyz', NULL, 7, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-s2v', 'nav-proxy-tools', 'S2V订阅器', NULL, 'https://s2v.lin8177.dpdns.org', 'http_get', 'https://s2v.lin8177.dpdns.org', NULL, 8, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-omnitt', 'nav-proxy-tools', 'TCP迷之调参', NULL, 'https://omnitt.com', 'http_get', 'https://omnitt.com', NULL, 9, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-sui', 'nav-proxy-tools', 'S-UI', NULL, 'https://github.com/alireza0/s-ui', 'http_get', 'https://github.com/alireza0/s-ui', NULL, 10, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-x-ui-yg', 'nav-proxy-tools', 'X-UI-YG', NULL, 'https://github.com/yonggekkk/x-ui-yg', 'http_get', 'https://github.com/yonggekkk/x-ui-yg', NULL, 11, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-reinstall', 'nav-proxy-tools', '一键重装', NULL, 'https://github.com/bin456789/reinstall', 'http_get', 'https://github.com/bin456789/reinstall', NULL, 12, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-shadowrocket', 'nav-proxy-tools', 'Shadowrocket去广告', NULL, 'https://github.com/LOWERTOP/Shadowrocket-First', 'http_get', 'https://github.com/LOWERTOP/Shadowrocket-First', NULL, 13, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),

  ('nav-yunwu', 'nav-artificial-intelligence', '云雾AI镜像站', NULL, 'https://yunwu.ai/', 'http_get', 'https://yunwu.ai/', NULL, 0, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-curry-api', 'nav-artificial-intelligence', 'CurryAPI镜像站', NULL, 'https://stephecurry.asia', 'http_get', 'https://stephecurry.asia', NULL, 1, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-chatgpt', 'nav-artificial-intelligence', 'ChatGPT', NULL, 'https://chat.openai.com', 'http_get', 'https://chat.openai.com', NULL, 2, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-gemini', 'nav-artificial-intelligence', 'Gemini', NULL, 'https://gemini.google.com', 'http_get', 'https://gemini.google.com', NULL, 3, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),

  ('nav-tailwind', 'nav-design-resources', 'Tailwind CSS', NULL, 'https://tailwindcss.com', 'http_get', 'https://tailwindcss.com', NULL, 0, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-fontawesome', 'nav-design-resources', '图标库', NULL, 'https://fontawesome.com.cn/v5', 'http_get', 'https://fontawesome.com.cn/v5', NULL, 1, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),

  ('nav-online-warp', 'nav-cloud-services', '在线warp', NULL, 'https://replit.com/repls', 'http_get', 'https://replit.com/repls', NULL, 0, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-starvm', 'nav-cloud-services', '星空云', NULL, 'https://www.starvm.cn/', 'http_get', 'https://www.starvm.cn/', NULL, 1, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-colocrossing', 'nav-cloud-services', 'Colocrossing', NULL, 'https://www.colocrossing.com', 'http_get', 'https://www.colocrossing.com', NULL, 2, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-racknerd', 'nav-cloud-services', 'RackNerd', NULL, 'https://www.racknerd.com', 'http_get', 'https://www.racknerd.com', NULL, 3, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-yunyoo', 'nav-cloud-services', '云悠', NULL, 'https://yunyoo.cc', 'http_get', 'https://yunyoo.cc', NULL, 4, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-lxc-wiki', 'nav-cloud-services', '拼垃圾', NULL, 'https://www.lxc.wiki', 'http_get', 'https://www.lxc.wiki', NULL, 5, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-bytevirt', 'nav-cloud-services', 'Bytevirt', NULL, 'https://bytevirt.com', 'http_get', 'https://bytevirt.com', NULL, 6, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-akile', 'nav-cloud-services', 'Akile', NULL, 'https://akile.io', 'http_get', 'https://akile.io', NULL, 7, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-acck', 'nav-cloud-services', 'ACCK', NULL, 'https://acck.io', 'http_get', 'https://acck.io', NULL, 8, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),

  ('nav-glsnote', 'nav-18-plus', '瓜老师笔记', NULL, 'https://glsnote.org', 'http_get', 'https://glsnote.org', NULL, 0, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-hanime1', 'nav-18-plus', 'Hanime1', NULL, 'https://hanime1.me', 'http_get', 'https://hanime1.me', NULL, 1, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
  ('nav-aabook', 'nav-18-plus', '疯情阅读', NULL, 'https://aabook.xyz', 'http_get', 'https://aabook.xyz', NULL, 2, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER));
