# Archify-Web — Linux 容器镜像（最小化：运行层无 npm、无 shell 之外的多余系统包）
# 一键部署：docker compose up -d --build  →  http://<主机>:8766
#
# 多阶段构建：
#   deps    = node:22-slim 只用来跑 npm ci，并裁掉非 x64-linux 的 ripgrep 二进制
#   运行层  = debian:bookworm-slim（glibc + bash）+ node 二进制 + 裁剪后的 node_modules
# 为什么不用 alpine：musl 下 Agent SDK 自带的 ripgrep / sharp 预编译二进制不保证可用；
# 为什么保留 bash：agent 的 Bash 工具依赖它，Debian 基础镜像本就自带。
# 注意：裁剪后镜像只支持 x64-linux 宿主机。
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# SDK 的 vendor/ripgrep 打包了 5 个平台的二进制，只留 x64-linux（省约 43MB）；
# sharp 的平台二进制 npm 会按构建机自动选，无需手工处理
RUN npm ci --omit=dev \
    && cd node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep \
    && rm -rf arm64-darwin arm64-linux x64-darwin x64-win32 \
    && npm cache clean --force

FROM debian:bookworm-slim
# node 二进制动态链接所需的唯一非基础库（glibc 系 slim 已含）；
# HTTPS 证书走 node 内置 Mozilla CA、时区走 node 内置 ICU 数据，无需 ca-certificates/tzdata
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 从 deps 层拷 node 本体与运行依赖（不带 npm/corepack/yarn，又省约 50MB）
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=deps /app/node_modules ./node_modules

# 应用本体（.dockerignore 已排除 node_modules / gallery / 备份 / 日志 / 测试）
COPY server.mjs claude.mjs cicd.mjs auth.mjs mermaid-import.mjs ./
COPY public ./public
COPY archify ./archify
COPY .agents ./.agents
COPY README.md ./

# agent 技能同步安装到 ~/.agents/skills（claude.mjs 的 additionalDirectories 覆盖那里）：
# code-diagram 拷贝一份；archify 用符号链接指向 /app/archify，避免 7MB 双份冗余
ENV HOME=/root
RUN mkdir -p /root/.agents/skills \
    && ln -s /app/archify /root/.agents/skills/archify \
    && cp -r .agents/skills/code-diagram /root/.agents/skills/code-diagram

# 容器内必须监听 0.0.0.0 端口映射才通；本地 HOST 默认 127.0.0.1 的行为不变
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8766
EXPOSE 8766

# 图集数据（manifest/图目录/issues.db/agent 设置与会话/cicd 状态）——compose 用具名卷持久化
VOLUME /app/gallery

# 无 curl/wget，用 node 内置 fetch 做健康检查（exec 数组形式，不依赖 shell）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8766)+'/api/diagrams').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
