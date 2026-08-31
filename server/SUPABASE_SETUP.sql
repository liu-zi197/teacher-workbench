-- 中小学教师智能工作台 · Supabase 建表脚本（前端直连版）
-- 用途：把密钥登记表(twb_keys)、管理员密码(twb_admin)、各 workspace 数据持久化到 Supabase 免费额度
-- 用法：登录 supabase.com → 打开你的项目 → SQL Editor → 粘贴本文件全部内容 → Run
--
-- ⚠️ 重要：本项目是「前端直连 Supabase」架构（无后端服务器），所以必须关闭 kv 表的 RLS，
--    并使用 anon public key（不要用 service_role，前端暴露 service_role 会被 Supabase 风控）。
--    关闭 RLS 意味着拿到 anon key 的人可读写全表——本工具仅内部发给老师使用，风险可控。

-- 一张通用的 KV 表：key 为字符串主键，value 存 JSON
create table if not exists kv (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz default now()
);

-- 关闭行级安全：前端直连需要 anon 能读写本表
alter table kv disable row level security;

-- 预置管理员密码（simpleHash('liu010806') = 'haa251827'）
-- 这样新项目首次即可用密码 liu010806 登录管理员后台，无需先初始化
insert into kv (key, value) values ('twb_admin', '{"pwd":"haa251827"}'::jsonb)
on conflict (key) do nothing;

-- 说明：老师访问密钥由管理员在「基础设置 → 密钥管理」里点「生成」自动写入 twb_keys 行，
--       无需在此手动添加。
