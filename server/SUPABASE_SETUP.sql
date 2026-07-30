-- 中小学教师智能工作台 · Supabase 建表脚本
-- 用途：Render 等临时文件系统环境下，把密钥与云端数据持久化到 Supabase(PostgreSQL 免费额度)
-- 用法：登录 supabase.com → 打开你的项目 → SQL Editor → 粘贴本文件全部内容 → Run

-- 一张通用的 KV 表：key 为字符串主键，value 存 JSON（keys 数组、各 workspace 的 DB 对象）
create table if not exists kv (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz default now()
);

-- 关闭行级安全：本应用所有访问都经过自有后端代理（已用 Bearer Token 鉴权），
-- 不需要 Supabase 的 RLS 策略。若你希望更严格，可自行开启 RLS 并配置策略。
alter table kv disable row level security;
