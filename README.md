# DbLab

面向 Agent 的数据库 MCP 管控平台。

企业内网里的 Agent 要读写数据库，通常各拿一把直连凭据：密钥散落在客户端里、拿不到完整调用记录、权限也没法按库收口。
DbLab 是一个**控制面**，把这条链收在一个平台上：

```
数据源配置 → 密钥签发 → 按数据源授读/写权 → 统一执行 → 全量审计
```

Agent 侧只拿到一把受限密钥和 `/mcp` 一个端点，一切鉴权与执行都发生在平台这边。

---

## 快速开始

前置：Node 20+、pnpm 10、一个空的 PostgreSQL 库（本平台自己的库），以及你打算纳管的库。

```bash
pnpm install
cp .env.example .env        # 至少确认 DATABASE_URL

pnpm db:migrate             # 建表 + 触发器 + CHECK
pnpm db:seed                # 创建初始管理员（admin / admin123）

pnpm dev                    # 服务端 :4000，管控台 :5173
```

打开 <http://localhost:5173>，用 `admin` / `admin123` 登录。

### Docker Compose 启动（本机）

平台库默认用**你自己的库**，compose 不自带数据库。先在仓库根 `.env` 里给 `DATABASE_URL`：

```bash
DATABASE_URL=postgresql://user:pass@host.docker.internal:5432/dblab   # 库在宿主机上时用 host.docker.internal
docker compose up -d --build
```

打开 <http://localhost:18400>，用 `.env` 里的管理员口令登录（未设时是 `admin123`）。

- 管控台与 `/mcp` 都在 `18400`，前端构建产物由服务端同端口托管，cookie 天然同源。
- 容器启动时自动跑迁移与种子，迁移失败会重试；两者都幂等，重启不会覆盖已有管理员口令。
- 容器里的 `localhost` 是容器自己，所以入口脚本会把连接串里的 `localhost` / `127.0.0.1`
  自动改写成 `host.docker.internal`（宿主机的库要在 `pg_hba.conf` 里放行该网段）。
- `dblab-data` 卷挂在 `/app/.data`，存凭据主密钥。**卷丢了，既有数据源口令就全部解不开。**
- 其余可覆盖项写在 `.env`：`ADMIN_USER`、`ADMIN_PASSWORD`、`MCP_ALLOWED_HOSTS`、`PORT` 等，
  compose 会自动读取；完整变量见下方环境变量表。
- 要纳管宿主机上的库，数据源主机同样填 `host.docker.internal`（compose 已加 `host-gateway`）。

**没有现成 PostgreSQL 时**，可以让 compose 自带一个（可选 profile）：

```bash
# .env 里把 DATABASE_URL 指向它
DATABASE_URL=postgresql://dblab:dblab_local_pw@postgres:5432/dblab
# postgres 口令在同一个 .env 里用 DB_PASSWORD 覆盖
docker compose --profile bundled-db up -d --build
```

自带库的宿主机端口是 `18432`（避开本机常见的 5432），数据在命名卷 `pgdata` 里。

`NODE_ENV` 默认 `development`：本地是 http，cookie 必须不带 `Secure`，否则浏览器不回传。
真要按生产跑，同时给 `NODE_ENV=production`、强口令与 `CREDENTIAL_MASTER_KEY`，并自行终结 TLS。

Agent 侧连接地址相应改为 `http://localhost:18400/mcp`。

> 种子只做一件事：**库里没有这个管理员时才创建**。
> 已存在就一行都不动，改 `.env` 里的 `ADMIN_PASSWORD` 再跑一次也不会覆盖已有口令——
> 否则每次部署都可能把管理员口令静默重置回默认值。

---

## 接一个 Agent

### 用 CLI 一键接入（推荐）

```bash
pnpm dblab setup        # 交互向导：填地址 → 粘密钥 → 选客户端 → 写入
```

默认服务地址是 **`http://localhost:18400`**，也就是 docker-compose 映射给宿主机的端口
（容器内仍是 4000）。用 `pnpm dev` 直接跑源码时给 `--url http://localhost:4000`。

向导会扫描本机已安装的客户端，把 `dblab` 这一条写进它们各自的配置文件（**不动其余条目**），
并在写入前用真实链路校验一次密钥——形态对但已吊销、地址填错、Host 不在白名单，都会当场说清楚。

其他命令：

```bash
pnpm dblab scan                     # 只扫描：装没装、配置在哪、有没有接入
pnpm dblab connect --key dblab_xxxx... --dry-run
pnpm dblab connect --url http://10.0.0.8:18400 --key dblab_xxxx... --agents cursor,codex
pnpm dblab disconnect --agents codex   # 只摘掉 dblab 条目

# 注册数据源，并自动把它授权给这把密钥
DBLAB_ADMIN_PASSWORD=xxx DBLAB_DB_PASSWORD=yyy \
pnpm dblab datasource --name orders --engine postgres \
  --host db.internal --database orders_db --username reader --key dblab_xxxx...
pnpm dblab datasource --name orders --engine postgres --database orders_db \
  --username reader --key dblab_xxxx... --write     # 顺带给写权限；省略参数则逐项来问
```

`datasource` 需要管理员会话——平台只允许管理面建数据源与改授权，Agent 那把 API 密钥没有这两个权限。
所以这里会登录一次 `admin`（`--admin-user` / `DBLAB_ADMIN_USER`，默认 `admin`）。
两个口令都优先走环境变量：命令行明文会留在 shell 历史里。
建之前一定先做一次连通性探测，**探测不过就不建库、不动授权**。

授权是「读回这把密钥现有的授权 → 追加新库 → 整表 PUT」。
平台的 PUT 语义是整表替换，直接 PUT 单条会把其它库的权限抹掉，所以这一步不能省；
同一个库已存在时只并权限，不会把已有的写权限降级成只读。

支持的客户端与写入位置：

| 客户端 | 配置文件 | 条目形态 |
|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers.dblab`（`type: http` + `headers`） |
| Cursor | `~/.cursor/mcp.json` | 同上 |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.dblab]` + `http_headers` |
| Qoder | `~/.qoder/settings.json` | `mcpServers.dblab` |
| Qoder CN | `~/.qoder-cn/settings.json` | 同上 |

写入约定：幂等（重复执行是原地更新）、保留缩进/换行/末尾换行、只改 `dblab` 那一处、
首次写入前留一份 `<文件>.dblab.bak`、配置文件解析不了就整体不写。
密钥明文会落到这些配置文件里（这是各客户端的既有形态），CLI 自己不做持久化。
所有输出里的密钥一律脱敏成 `dblab_<定位段>_••••`。

`apps/cli` 是可发布的 npm 包（`bin: dblab`）：

```bash
pnpm --filter @dblab/cli build      # 产物 dist/index.js
cd apps/cli && npm pack --dry-run
```

### 手工配置（兜底）

1. 管控台 →「数据源」→ 新建，填 host/port/库名/账号/口令，点「测试连接」。
2. 「密钥」→ 新建，在授权矩阵里勾上这个库（读，或读+写），复制一次性明文。
3. 把下面这段配到 Agent 的 MCP 客户端里：

```json
{
  "mcpServers": {
    "dblab": {
      "type": "streamable-http",
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer dblab_xxxxxxxx_your-onetime-secret"
      }
    }
  }
}
```

### 工具集

工具**按授权动态注册**，不是「看得到但调不动」：

| 工具 | 说明 | 出现条件 |
|---|---|---|
| `list_datasources` | 只列出这把密钥被授权的库 | 总是 |
| `list_tables` | 表与视图清单，走 `information_schema` | 有任一读授权 |
| `describe_table` | 列、类型、可空、默认值、主键 | 有任一读授权 |
| `query` | 只读语句（SELECT / EXPLAIN / SHOW） | 有任一读授权 |
| `execute` | 写入语句（INSERT / UPDATE / DELETE） | **有任一写授权** |

只读密钥在 `tools/list` 里根本看不到 `execute`。
管理面上改完授权，**已经在跑的会话不用重连**：下一次 `tools/list` 就会变。

---

## 权限模型

三条规则，按重要性排：

1. **读 = SELECT / EXPLAIN / SHOW；写 = INSERT / UPDATE / DELETE；DDL 一律拒绝并记审计。**
2. **判权看语句分类，不看调的是哪个工具。**
   否则「有写权限但没读权限」的密钥可以拿 `execute` 跑 `SELECT` 把数据读走。
3. **未授权与不存在不可区分。**
   对无权访问的库名和压根不存在的库名，返回逐字节相同的 `datasource_not_found_or_unauthorized`
   ——不然 Agent 能靠返回码把平台上有哪些库枚举出来。

### 语句闸门是两层，不是一层

`packages/shared/src/sql/classify.ts` 里那个分类器**不是安全边界**，它只是默认拒绝的快速过滤层
（去注释与字符串、判多语句、取首关键字、CTE 后接 DML 归写、识别 `INTO OUTFILE` / `LOAD_FILE` / `SET GLOBAL` 这类风险项）。

真正的后盾是执行时的只读事务：

- 读路径：PostgreSQL `BEGIN TRANSACTION READ ONLY`，MySQL `SET TRANSACTION READ ONLY`。
- 写路径与读路径分开走不同的执行通道，且每条语句都带 `statement_timeout`。
- 每个数据源一个惰性连接池（默认 4 条），空闲回收、配置一改就重建、停用即刻拦下。

绕开分类器直接调适配器的写语句，会被数据库自己拒掉——测试里就有一条故意绕过闸门的用例来证明这层真的存在。

### 会话与凭据

- 管理端会话：HttpOnly + SameSite=Lax cookie，库里只存令牌摘要。
- API 密钥：`dblab_<8 位定位段>_<43 位秘密段>`，明文只在创建响应里出现一次；库里只有定位段与 `sha256(秘密段)`。
  定位段查不到时也会走一次同价摘要比对，否则按前缀可以时序枚举。
- 数据源口令：`aes-256-gcm` 加密入库（`v1:<iv>:<tag>:<ct>`），任何读接口只回 `passwordConfigured: true|false`。
  编辑时**不带 password 字段 = 不改口令**，既有密文逐字节保留。
- 审计只增不改：应用层没有更新/删除入口，DB 触发器再兜一层（`UPDATE`/`DELETE`/`TRUNCATE` 直接报错）。

---

## 环境变量

复制 `.env.example` 为 `.env`。空字符串按「没配」处理，落到默认值。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | — | 平台自身库（数据源配置、密钥、授权、审计）。必填 |
| `PORT` | `4000` | 管理面与 `/mcp` 共用这一个端口 |
| `CREDENTIAL_MASTER_KEY` | 空 | 32 字节 base64（`openssl rand -base64 32`）。生产必填 |
| `CREDENTIAL_MASTER_KEY_FILE` | 仓库根 `.data/credential-master.key` | 没配上一项时用这里的文件；首次自动生成（0600） |
| `SESSION_TTL_MINUTES` | `720` | 管理端会话有效期 |
| `SESSION_COOKIE_NAME` | `dblab_session` | cookie 名 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `admin123` | 只用于种子；库里已有该用户时不生效。生产必须显式给 `ADMIN_PASSWORD` |
| `MCP_MAX_SQL_BYTES` | `100000` | 单条语句长度上限，超出 `sql_too_large` |
| `MCP_MAX_ROWS` | `500` | 读返回行数上限；Agent 传的更大值按本值截断，响应带 `truncated: true` |
| `MCP_STATEMENT_TIMEOUT_MS` | `15000` | 语句执行超时，读写都算 |
| `MCP_SESSION_TTL_MINUTES` | `30` | MCP 会话空闲回收 |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | `/mcp` 允许的 Host（逗号分隔、不含端口，`*` 关闭校验）。挡 DNS rebinding |
| `POOL_MAX` | `4` | 每个被纳管数据源的连接池上限 |
| `POOL_IDLE_EVICT_MINUTES` | `15` | 空闲池回收 |
| `TRUST_PROXY` | `0` | 只有服务确实挂在反向代理后面才设 `1`，否则 IP 白名单会被代理地址带偏 |
| `WEB_DIST_DIR` | 空 | 前端构建产物目录。设了就由服务端同端口托管管控台（Docker 镜像里指向 `/app/apps/web/dist`） |

启动时会打出主密钥的实际来源与路径。
密钥文件路径按**仓库根**解析而不是 `process.cwd()`——两个进程 cwd 不同会各生成一把密钥，之后互相解不开。

解密失败给两个不同的码：`master_key_unavailable`（主密钥这侧的问题）与 `credential_undecryptable`（密文解不开）。
都**不会返回空串**：空口令会被读成「这个数据源没配口令」，排查方向直接就错了。

---

## 代码结构

```
apps/server    Fastify 5：管理面 REST + /mcp（Streamable HTTP）
apps/web       Vue 3 + Vite + Tailwind v4 + shadcn-vue
apps/cli       dblab CLI：扫描本机 Agent、校验密钥、写入各客户端配置，并可注册数据源+自动授权（可发布的 npm 包）
packages/shared 错误码与中文文案、审计词表、SQL 分类器、CIDR 匹配、DTO schema —— 前后端同源
packages/db    Drizzle schema、迁移、口令/密钥/凭据加解密、种子
docker/        容器入口脚本（迁移 → 种子 → 启动）
```

CLI 刻意不依赖 `@dblab/shared` / `@dblab/db`——它要作为独立包发布，只能带自己的依赖。
密钥形态校验因此在 `apps/cli/src/core/key.ts` 里另存了一份，服务端仍是唯一权威。

`apps/server` 设了 `WEB_DIST_DIR` 时会顺带托管 `apps/web` 的构建产物：管控台与 `/mcp` 同端口，
cookie 会话不用为跨源再开 CORS。SPA 路由回退只对无扩展名的路径生效，缺资源仍回 JSON 404。

前端原则：**同一类交互在全平台只有一份实现**。
列表的加载/空/错三态与分页只在 `DataTable`，表单校验与提交态只在 `FormDialog` + `useForm`，
危险操作确认只在 `ConfirmDialog`，状态色板只在 `StatusBadge`，时间与枚举中文标签只在 `utils/` 与 `packages/shared`。
页面（`views/*`）只做组合，不出现自己写的骨架、`toast(`、确认弹窗或分页。

---

## 开发与验证

```bash
pnpm typecheck              # 各包 tsc / vue-tsc
pnpm test                   # 未设下面两个变量时，需要活库的用例整体跳过
pnpm --filter @dblab/web build
pnpm --filter @dblab/cli test      # CLI 单测全部注入临时 home，不碰真实用户配置
```

跑需要真实库的用例时给两个测试库（都是本机 PostgreSQL）：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/dblab_test' \
TEST_PROBE_URL='postgresql://postgres:postgres@localhost:5432/dblab_probe' \
pnpm -r test
```

- `dblab_test`：平台库的镜像，集成用例在它上面跑迁移、CRUD、授权、审计触发器。
- `dblab_probe`：被纳管的 scratch 库，执行面与 MCP 用例在里面建自己的 `probe_items` / `mcp_probe`。

审计表有只增不改触发器，所以**测试跑完的历史记录删不掉**，用例都对残留行做了容忍。

---

## 已知缺口（如实记录）

1. **MySQL 适配器没有真实库验证过。**
   本机 3306 有 MySQL 8 但没有可用凭据。覆盖方式是：目录 SQL 字符串的单元断言、
   `SET TRANSACTION READ ONLY` 在序列里第 1 位的断言、`multipleStatements: false` 的断言、以及 MySQL 方言的风险用例。
   数据源详情页的「测试连接」按钮是人工验证通道。**这是本仓库唯一的真实覆盖缺口。**
2. **成功写的提交与审计插入不是原子的。**
   窗口是微秒级，且审计写在响应之前。审计写失败时工具返回 `isError: true, code: audit_write_failed`
   而不是假装成功，同时把整行打进服务端日志。要真正闭合得在执行前先写一行 `detail.phase='attempted'`，
   那是用「双倍行数」换这个缺口，v1 不划算。
3. **只读事务的残余缺口。** v1 每个数据源只有一套凭据，所以只读事务是唯一的服务端后盾：
   PostgreSQL 的只读事务里 `nextval()` 与 `CREATE TEMP TABLE` 仍可执行；
   MySQL 的只读事务**拦不住 `SELECT ... INTO OUTFILE`**，因此文本风险扫描在 MySQL 上是承重的。
   长期正解是给数据源配一个真正的只读账号（`connect_options.readOnlyRole` 已预留，v1 不使用）。
4. **写路径不设影响行数上限。** 授权即许可，`UPDATE` 忘了 `WHERE` 会真的全表改；`row_count` 事后在审计里可见。
5. **MCP 会话是进程内状态。** 本平台按单进程运行；多实例部署需要把会话外置，v1 没做。
6. **首版不含**：管理端 SQL 控制台、密钥级限流、审计导出与保留期。
7. **CLI 只适配 5 个客户端**（Claude Code / Cursor / Codex / Qoder / Qoder CN），
   且是**定点文本替换**而不是按各家 schema 反序列化：客户端若把配置结构改版，
   需要同步改 `apps/cli/src/adapters/`。写入前一律留 `.dblab.bak`，解析不了就整体不写。

---

## 排错

| 现象 | 先看这里 |
|---|---|
| Agent 连上但看不到 `execute` | 这把密钥在该库上没有写授权（`tools/list` 里没有，不是被禁用） |
| `401 api_key_invalid` | 秘密段不对；库里只有摘要，改不回来，只能重新签发 |
| `403 ip_not_allowed` | 来源 IP 不在白名单；直连时来源是 socket 对端，走代理时须开 `TRUST_PROXY` |
| `403 forbidden`（调 `/mcp`） | `Host` 不在 `MCP_ALLOWED_HOSTS` 里，或浏览器带的 `Origin` 与 `Host` 不同源 |
| `401 api_key_expired` | 有效期到了。到期时刻按当天 `23:59:59` 算（界面上填的是日期） |
| 口令解不开 | 主密钥变了或密钥文件路径不一致；看启动日志里打出的来源 |
