# dblab-cli

DbLab 的命令行客户端。扫描本机已安装的 Agent 客户端，把 DbLab 的 MCP 端点写进它们的配置，
并在写入前用真实链路校验一次密钥。

平台本体（管控台、`/mcp` 服务、审计）在同一个仓库：
<https://github.com/lq200lq/dblab>

## 安装

```bash
npm install -g dblab-cli
# 或不安装直接跑
npx dblab-cli scan
```

## 命令

```bash
dblab setup            # 交互向导：填地址 → 粘贴密钥 → 选客户端 → 写入
dblab scan             # 只扫描：装没装、配置文件在哪、有没有接入
dblab connect          # 非交互写入
  --key dblab_xxxx... [--url http://localhost:18400] [--agents cursor,codex] [--dry-run]
dblab disconnect       # 只摘掉 dblab 条目，其余配置不动
  [--agents cursor,codex]
dblab datasource       # 注册数据源，并自动授权给当前这把密钥（省略 --key 用连接记录里那把）
  [--key dblab_xxxx...] --name orders --engine postgres --database orders_db --username reader
dblab datasource list  # 列出这把密钥被授权的数据源与读写权限
  [--key dblab_xxxx...] [--url http://localhost:18400]
```

默认服务地址是 `http://localhost:18400`（docker-compose 映射给宿主机的端口）。
用 `pnpm dev` 直接跑源码时给 `--url http://localhost:4000`。

## 已适配的客户端

| 客户端 | 配置文件 |
|---|---|
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| Codex CLI | `~/.codex/config.toml` |
| Qoder | `~/.qoder/settings.json` |
| Qoder CN | `~/.qoder-cn/settings.json` |

## 写入行为

- **幂等**：重复执行是原地更新 `dblab` 那一条，内容一致时不落盘。
- **非破坏**：只改 `mcpServers.dblab`（Codex 是 `[mcp_servers.dblab]` 段），其余条目原样保留；
  保留原缩进、换行风格与文件末尾是否有换行。
- **可回滚**：每个文件首次写入前生成一次 `<文件>.dblab.bak`。
- **失败即中止**：任一配置文件解析不了，本次整体不写。
- **原子写**：同目录临时文件 + rename；Windows 上被进程占用时重试并给出明确提示。

## 密钥

`dblab connect`/`setup` 需要一把在 DbLab 管控台「密钥」里签发的明文（`dblab_<8 位定位段>_<43 位秘密段>`，
只在创建时显示一次）。写入前 CLI 会真的连一次 `/mcp` 做校验：

- `401` → 密钥无效、已吊销或已过期
- `403` → 目标主机名不在服务端的 `MCP_ALLOWED_HOSTS` 里
- 连不上 / 超时 → 服务没启动或地址填错

明文会按各客户端的既有形态写进配置文件（Agent 侧就是靠这个头鉴权）；
`connect` / `setup` 另外在 `~/.dblab/config.json` 记一份「当前连接」的密钥与地址，
落盘尽力收到 0600（Windows 上这个权限位基本被忽略）。所有输出里一律脱敏成 `dblab_<定位段>_••••`。

### 当前连接

这份记录就是「刚才接到哪台、用的哪把」：

- `dblab datasource` 省略 `--key` 时授权给记录里那把，地址也跟着它走；显式传 `--key` 时地址仍按
  `--url` 或默认值走，不会被记录带跑到另一台服务上。
- `dblab datasource list` 同样先取 `--key`，没有就取记录。
- `dblab disconnect` 不带 `--agents`（整体断开）时连同记录一起清掉；只摘一两家时保留，
  因为其余客户端还在用同一把密钥连着。
- 记录读不懂（不是合法 JSON、缺字段、密钥形态不对）就直接报错并指向那个文件，
  不会静默当成「没连过」——拿错密钥去授权是一次没人会发现的权限变更。

`dblab datasource` 例外：建数据源与改授权在平台上只能通过管理面完成，所以它会用管理员账号登录一次
（`--admin-user` / `DBLAB_ADMIN_USER`，口令走 `--admin-password` 或环境变量 `DBLAB_ADMIN_PASSWORD`）。
授权是「读回这把密钥现有的授权 → 合并新库 → 整表 PUT」，因为平台的 PUT 是替换语义。

`dblab datasource list` 不需要管理员口令：它就以那把密钥的身份连 `/mcp` 调 `list_datasources`，
这正是 Agent 实际看到的视图——没授权的库不会出现在结果里，一把权限都没有时是一张空表加一句提示，
而不是报错。

## 退出码

`0` 成功 / `1` 校验失败 / `2` 用法错误 / `3` 写入或连通性探测失败

## License

Apache-2.0
