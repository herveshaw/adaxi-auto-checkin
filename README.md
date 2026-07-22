# adaxi-auto-checkin

adaxi.net 自动签到 Cloudflare Worker，支持手动签到和 AI 自动签到两种模式。

> ⚠️ 本项目由 AI（TRAE 助手）编写生成。

## 功能

### 手动签到（网页 /）
- 显示验证码图片，手动输入 2 位字符完成签到
- 签到成功显示获得的流量；今日已签则独立提示
- 100% 成功率

### AI 自动签到（cron + /checkin）
- 使用 Cloudflare Workers AI 的 `@cf/meta/llama-4-scout-17b-16e-instruct` 视觉模型识别验证码
- 自动尝试多种大小写组合
- 失败自动重试（次数可在管理面板配置）

### 管理面板（/admin）
- 账号密码登录
- 调度配置：启用开关、签到时间（北京时间小时多选）、最大重试次数
- 历史记录：每次签到的结果、流量、OCR 输出、尝试次数、耗时、完整日志
- 统计数据：累计获得流量、成功率、平均尝试次数、上次运行时间等
- 配置存 KV，修改后立即生效，无需重新部署

## 部署

### 前置要求
- Cloudflare 账号
- Node.js + wrangler CLI

### 步骤

1. 克隆仓库
   ```bash
   git clone https://github.com/yzgmc/adaxi-auto-checkin.git
   cd adaxi-auto-checkin
   ```

2. 安装依赖
   ```bash
   npm install
   ```

3. 创建 KV namespace
   ```bash
   npx wrangler kv namespace create CHECKIN_KV
   ```
   把返回的 `id` 填入 `wrangler.toml` 的 `[[kv_namespaces]]`。

4. 设置 Secrets
   ```bash
   npx wrangler secret put ADAXI_USERNAME    # adaxi.net 登录账号
   npx wrangler secret put ADAXI_PASSWORD    # adaxi.net 登录密码
   npx wrangler secret put ADMIN_USERNAME    # 管理面板登录账号
   npx wrangler secret put ADMIN_PASSWORD    # 管理面板登录密码
   npx wrangler secret put ADMIN_TOKEN       # 签到 API 鉴权 token
   ```

5. 部署
   ```bash
   npx wrangler deploy
   ```

## 技术要点

- **验证码机制**：adaxi 的验证码为 2 位字符，`/captcha` 接口会设置 `vpnpn888` cookie 绑定答案，`/api/user/sign` 必须携带该 cookie 才能验证通过。Worker 的 `fetch` 需手动处理 Set-Cookie（`getSetCookie()` 在部分运行时返回空，需 fallback 到 `headers.get('set-cookie')`）。
- **OCR 模型**：选用 Llama 4 Scout 17B，对 2 位字符的大小写识别比 llava-1.5-7b 更可靠。
- **调度**：Cron 每小时触发一次，scheduled() 读取 KV 配置的北京时间小时列表决定是否执行，实现在线改时间无需重新部署。

## 技术栈

- Cloudflare Workers
- Workers AI（视觉模型 OCR）
- Workers KV（配置和历史记录持久化）
- Cron Triggers（定时触发）
- 纯 HTML/CSS/JS 前端（无构建依赖）

## 许可

仅供学习交流使用。
