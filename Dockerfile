# 单镜像：前端构建产物 + Fastify 服务端 + 迁移/种子脚本。
# 运行时仍用 tsx 直接跑 TS（与本地一致），因此不单独做编译产物。

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.18.1 --activate

WORKDIR /app

# 先只拷贝清单，让依赖层在源码变更时仍然命中缓存。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @dblab/web build

FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.18.1 --activate

WORKDIR /app

COPY --from=build /app /app
COPY docker/entrypoint.sh /usr/local/bin/dblab-entrypoint
RUN chmod +x /usr/local/bin/dblab-entrypoint

# 主密钥文件落在 /app/.data，由 compose 挂卷持久化。
VOLUME ["/app/.data"]

EXPOSE 4000

ENTRYPOINT ["dblab-entrypoint"]
