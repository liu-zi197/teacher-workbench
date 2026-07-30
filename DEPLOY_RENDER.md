# 中小学教师智能工作台 · Render 免费部署保姆级指南

> 目标：0 元把后端部署到 Render，数据存在 Supabase。全程约 15 分钟。

---

## 一、你需要准备什么

| 东西 | 用途 | 说明 |
|---|---|---|
| GitHub 账号 | 放代码 | https://github.com |
| Supabase 账号 | 免费数据库 | https://supabase.com |
| Render 账号 | 免费 Node 主机 | https://render.com |
| 本机已安装 Git | 推代码到 GitHub | 没有的话见下方「附录 A」 |

---

## 二、整体流程（先心里有数）

```
1. Supabase 建库（拿到 URL + KEY）
        ↓
2. 把本机代码推到 GitHub（Render 会从 GitHub 拉代码）
        ↓
3. Render 关联 GitHub 仓库，填环境变量
        ↓
4. Render 自动部署，给你一个网址
        ↓
5. 把这个网址填到工作台「基础设置 → 云端服务器地址」
```

---

## 三、Step 1：Supabase 建库（5 分钟）

### 3.1 注册/登录
打开 https://supabase.com，用 GitHub 账号直接登录。

### 3.2 新建项目
1. 登录后点击右上角 **"New project"**
2. Organization 选默认的（或新建一个）
3. Project name 填：`teacher-workbench`
4. Database Password：点 **"Generate a password"** 自动生成，**复制保存好**
5. Region 选离你最近的：`East Asia (Northeast Asia)` 或 `Southeast Asia (Singapore)`
6. 点击 **"Create new project"**

> 等待 1-2 分钟，项目创建中。

### 3.3 运行建表 SQL
1. 项目创建好后，左侧菜单找到 **"SQL Editor"**，点击打开
2. 点击 **"New query"**
3. 把 `server/SUPABASE_SETUP.sql` 文件里的内容**全部复制**进去：
   ```sql
   create table if not exists kv (
     key         text primary key,
     value       jsonb not null,
     updated_at  timestamptz default now()
   );
   alter table kv disable row level security;
   ```
4. 点击右上角 **"Run"**
5. 看到 `Success. No rows returned` 即可

### 3.4 拿到两个关键参数
1. 点击左侧 **"Project Settings"**（齿轮图标）
2. 再点 **"Data API"**
3. 找到：
   - **Project URL**（类似 `https://xxxxxxxxxxxxxxxxxxxx.supabase.co`）
   - **Project API keys** → 复制 `service_role secret` 那一串

> 把这两个值**临时保存在记事本**里，下一步要填到 Render。

---

## 四、Step 2：把代码推到 GitHub（3 分钟）

### 4.1 在 GitHub 新建仓库
1. 打开 https://github.com/new
2. Repository name 填：`teacher-workbench`
3. 选 **Public**（免费；Private 也可以，但 Render 免费层关联 Private 仓库步骤稍多）
4. **不要勾选** "Initialize this repository with a README"
5. 点击 **"Create repository"**

创建后会看到一段命令，类似：
```bash
git remote add origin https://github.com/你的用户名/teacher-workbench.git
git branch -M main
git push -u origin main
```

### 4.2 在本机推代码
打开终端（Git Bash / PowerShell / CMD），依次执行：

```bash
# 1. 进入项目目录
cd C:\Users\Administrator\WorkBuddy\2026-07-30-09-17-04\teacher-workbench

# 2. 初始化 git（如果还没初始化）
git init

# 3. 添加所有文件
git add .

# 4. 提交
git commit -m "init: teacher workbench"

# 5. 关联你的 GitHub 仓库（把下面地址换成你的）
git remote add origin https://github.com/你的用户名/teacher-workbench.git

# 6. 推送
git branch -M main
git push -u origin main
```

> 推送时需要输入 GitHub 用户名和密码（或弹窗让你登录）。

---

## 五、Step 3：Render 部署（5 分钟）

### 5.1 登录 Render
打开 https://render.com，用 GitHub 账号登录。

### 5.2 用 Blueprint 一键部署
1. 登录后点击顶部 **"Blueprints"**
2. 点击 **"New Blueprint Instance"**
3. 在列表里找到你的 GitHub 仓库：`teacher-workbench`
4. 点击 **"Connect"**
5. Service Name 保持默认 `teacher-workbench`，或改成你喜欢的
6. 点击 **"Create Blueprint Instance"**

### 5.3 填环境变量
Render 会读取 `render.yaml`，但环境变量需要你手动填：

1. 部署页面里找到 `teacher-workbench` 这个服务，点击进入
2. 左侧点 **"Environment"**
3. 点击 **"Add Environment Variable"**，逐个添加：

| Key | Value | 说明 |
|---|---|---|
| `SUPABASE_URL` | `https://xxxxxxxx.supabase.co` | 刚才 Supabase 复制的 Project URL |
| `SUPABASE_KEY` | `eyJ...` | 刚才 Supabase 复制的 `service_role secret` |
| `SECRET` | 随便一串 32 位以上随机字符 | 用于签发登录 token，例如：`my-secret-key-2026-teacher-workbench-abc123` |
| `ADMIN_KEY` | 你自己定一个管理员密码 | 例如：`admin2026`；用来批量生成教师密钥 |
| `ALLOW_SELF_REGISTER` | `true` | 自助注册模式：任何密钥首次登录自动创建空间 |
| `AI_KEY` | （可选）你的硅基流动/DeepSeek key | 不填也能跑，只是 AI 功能回退模板 |
| `AI_BASE` | （可选）`https://api.siliconflow.cn/v1` | 硅基流动默认地址 |
| `AI_MODEL` | （可选）`deepseek-ai/DeepSeek-V3` | 默认模型 |

4. 填完后点击顶部 **"Save Changes"**

### 5.4 等待部署完成
1. 点击顶部 **"Deploy"** 标签，等待状态变成 **"Live"**
2. 部署完成后，页面上方会出现一个网址：`https://teacher-workbench-xxx.onrender.com`
3. **复制这个网址**

> 首次部署可能需要 2-5 分钟。Render 免费层如果 15 分钟没人访问会休眠，下次访问时冷启动约 30 秒，这是正常现象。

---

## 六、Step 4：前端对接 Render 后端

### 方案 A：直接用 Render 地址访问（推荐，最简单）
打开 `https://teacher-workbench-xxx.onrender.com`，这就是完整的工作台（后端+前端一起）。

### 方案 B：继续用 CloudStudio 链接，但把 API 指向 Render
1. 打开之前的 CloudStudio 链接
2. 登录后进入 **「基础设置」**
3. 找到 **「云端服务器地址」**
4. 填入 Render 地址：`https://teacher-workbench-xxx.onrender.com`
5. 点击 **「保存云端地址」**
6. 退出登录，重新用密钥登录

---

## 七、Step 5：测试是否成功

1. 用任意密钥（例如 `teacher1`）登录
2. 添加一条学生成绩或点名记录
3. 刷新页面，重新登录
4. 数据还在 → 云端同步成功 ✅

---

## 八、常见问题

### Q1：Render 部署失败，日志显示 `Cannot find module`？
A：本后端是零依赖的，不应该出现。请检查 `render.yaml` 里的 `startCommand` 是否为 `node server/server.js`。

### Q2：登录后数据没有同步？
A：检查 Render 的 Environment 里 `SUPABASE_URL` 和 `SUPABASE_KEY` 是否填对。`SUPABASE_KEY` 必须用 `service_role secret`，不是 `anon public`。

### Q3：CloudStudio 前端填了 Render 地址后还是本地模式？
A：确保地址以 `https://` 开头，末尾没有斜杠 `/`。填完后要**重新登录**才生效。

### Q4：忘记 ADMIN_KEY 怎么办？
A：去 Render 的 Environment 里修改 `ADMIN_KEY`，保存后 Render 会自动重新部署。

---

## 附录 A：安装 Git（如果本机没有）

1. 打开 https://git-scm.com/download/win
2. 下载安装包，一路 Next 安装
3. 安装完成后，打开 Git Bash，输入：
   ```bash
   git --version
   ```
4. 显示版本号即成功
