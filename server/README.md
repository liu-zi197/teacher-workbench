# 中小学教师智能工作台 · 云端多用户版（阶段二）

在前一版「本地原型」基础上，新增：**密钥登录 + 按老师隔离的云端数据 + 服务端 AI 代理**。
老师凭你发放的密钥进入自己的独立空间；AI 的 key 只存在服务器，老师无感调用，你不暴露 key 也不亏钱。

## 目录结构
```
teacher-workbench/
├── index.html          前端入口（含登录屏）
├── app.js              前端逻辑（登录 / 云端读写 / AI 入口 / API 地址可配置）
├── style.css           样式（模块化卡片风格）
└── server/             零依赖 Node 后端
    ├── server.js       托管前端静态 + 处理 /api/*（存储可插拔：Supabase / 本地文件）
    ├── package.json
    ├── .env.example    环境变量示例（复制为 .env 使用）
    ├── test.js         接口自测脚本
    ├── SUPABASE_SETUP.sql   建表脚本（接 Supabase 时执行一次）
    ├── render.yaml     Render Blueprint 配置（一键部署用）
    └── data/           本地开发时的运行时数据（keys.json + ws/*.json，勿提交）
```

## 一、本地运行（最快验证）
```bash
cd server
node server.js            # 浏览器打开 http://localhost:3000
```
- 首次打开显示登录屏：可点「先本地体验（无需密钥）」用 localStorage 模式；
- 或用任意密钥登录（默认 `ALLOW_SELF_REGISTER=true`，会自动建独立空间）。
- 不配置数据库时，本地数据存 `server/data/`（JSON 文件）。

## 二、配置 AI（免费也能用）
1. 复制 `server/.env.example` 为 `server/.env`
2. 到 [硅基流动](https://siliconflow.cn) 或 [DeepSeek 开放平台](https://platform.deepseek.com) 注册，**领取免费额度**，拿到 API Key
3. 在 `.env` 填写：
   ```
   AI_KEY=你的key
   AI_BASE=https://api.siliconflow.cn/v1
   AI_MODEL=deepseek-ai/DeepSeek-V3
   ```
4. 重启 `node server.js`。老师在工作台点「AI生成」即调用，**key 只在服务器，老师看不到也不会花钱暴露**。
5. 没填 `AI_KEY`：前端自动回退到内置模板生成，功能不中断、零成本。

## 三、发放教师密钥（你的收费/管理入口）
1. 在 `.env` 设置 `ADMIN_KEY=你的管理员密钥`，重启服务
2. 调用一次发放（可用浏览器/Postman/curl）：
   ```bash
   curl -X POST http://localhost:3000/api/admin/issue \
     -H "Content-Type: application/json" \
     -d '{"adminKey":"你的管理员密钥","count":10}'
   ```
   返回 10 个形如 `TWB-XXXX` 的密钥，发给对应老师即可。
3. 也可把密钥直接写进 `server/data/keys.json`（数组元素 `{key,name,ws,active:true}`）。

## 四、部署到云端（让别人能访问 + 数据持久）

后端是单文件 `server.js`（零依赖），**任何能跑 Node 18+ 的地方都能部署**。
⚠️ 关键提醒：**Render 免费层 / 多数 Serverless 的文件系统是临时的**，重启/重新部署会清空本地 JSON。
所以生产环境必须把存储切到 **Supabase（PostgreSQL 免费额度）**——后端已内置「检测到 `SUPABASE_URL` 就自动改用 Supabase」，无需改代码。

### 方案 A（推荐·零成本 Serverless）：Render 免费层 + Supabase

**第 1 步：准备一个免费 Supabase 数据库**
1. 打开 [supabase.com](https://supabase.com) 注册并「New Project」（免费额度够个人/小团队）。
2. 左侧菜单 → **SQL Editor** → 新建查询 → 把本仓库 `server/SUPABASE_SETUP.sql` 的内容**全部粘贴进去** → **Run**。
   这会建一张 `kv` 表（关掉了 RLS，访问由我们后端自己的 Token 鉴权）。
3. 左侧菜单 → **Project Settings → API**：
   - 复制 **Project URL**（形如 `https://xxxx.supabase.co`）→ 即 `SUPABASE_URL`
   - 复制 **anon / public** 那一行的 key（project API key）→ 即 `SUPABASE_KEY`

**第 2 步：把代码推到 GitHub**
- 把整个 `teacher-workbench` 目录推到一个 GitHub 仓库（`.env`、`server/data/` 不要提交；可加 `.gitignore`）。

**第 3 步：Render 一键部署**
1. 打开 [render.com](https://render.com) 注册 → **New → Blueprint** → 关联上面的 GitHub 仓库。
2. Render 会自动读取 `server/render.yaml`：创建名为 `teacher-workbench` 的免费 Web 服务，启动命令 `node server/server.js`。
3. 在 Render 控制台为该服务添加**环境变量**（与本地 `.env` 对应）：
   | 变量 | 值 |
   |---|---|
   | `SUPABASE_URL` | 第1步复制的 Project URL |
   | `SUPABASE_KEY` | 第1步复制的 anon key |
   | `AI_KEY` | （可选）硅基流动/DeepSeek 免费 key |
   | `AI_BASE` | `https://api.siliconflow.cn/v1`（可选） |
   | `AI_MODEL` | `deepseek-ai/DeepSeek-V3`（可选） |
   | `ADMIN_KEY` | （建议设置）你的管理员密钥，用于发教师密钥 |
   | `SECRET` | 一串固定随机串（生产务必设置，否则重启后已发 Token 失效）|
   | `CORS_ORIGIN` | 若用 CloudStudio 等独立静态前端，填其域名；否则留空默认 `*` |
4. 部署完成后，Render 会给你一个 `https://teacher-workbench.onrender.com` 地址，**这就是你的云端后端**。

**第 4 步：让前端连上它**
- 方式 1（最简单）：直接用 Render 提供的地址访问——因为后端同时托管了前端，同源 `API_BASE=/api` 自动生效。
- 方式 2（保留 CloudStudio 静态前端）：在 CloudStudio 打开工作台 → 进入「基础设置」→ 找到「云端服务器地址」→ 填 `https://teacher-workbench.onrender.com` → 保存 → 重新登录。前端即通过跨域(CORS)连上 Render 后端。

> Render 免费层有「闲置 15 分钟会休眠、下次访问冷启动约十几秒」的限制，属正常现象。

### 方案 B：自有轻量云（最稳，推荐正式收费）
- 国内 2C2G 轻量云约 50–90 元/月，装好 Node 后 `node server/server.js` 即可（建议用 `pm2 start server.js` 守护，nginx 反代）。
- 数据存在 `server/data/`（JSON 文件），重启不丢，完全由你掌控；也可同样配置 `SUPABASE_URL` 用云库。

### 方案 C：Vercel / Cloudflare Workers（纯 Serverless）
- 当前 `server.js` 用原生 http，需适配为平台函数入口；数据库也需从 JSON 文件改为 Supabase/D1。
- 适合大规模、零运维，但改造量更大，按需再做。

> 无论哪种，关键是：**老师的密钥 ≠ AI 的 key**。AI 调用成本单次仅约 1–2 分钱，从你的订阅费里覆盖即可。

## 五、自测
```bash
cd server
node test.js     # 自动验证：登录→云端读写→空间隔离→AI回退→401/403拦截→静态200→源码禁读
```

## 六、安全说明
- 已禁止通过静态服务访问 `server/` `data/` 源码与数据文件（403）。
- 老师数据按 workspace 隔离，互不可见。
- AI key 仅在服务端使用，前端只传 prompt，拿回生成文本；不配置则回退模板。
- 跨域(CORS)默认 `*`，对接指定静态前端时建议把 `CORS_ORIGIN` 设为该前端域名。
