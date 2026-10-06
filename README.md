# 胶片冲洗参数库

面向黑白与彩色胶片冲洗者的本地参数管理工具。可以按乳剂批次登记胶片、记录显影液工作液寿命、编排冲洗配方，并把每次实冲温度、时间和样片结果沉淀为下一批次的修正依据。应用为纯前端单页应用，不需要后端服务或外部接口。

## Docker 一键启动

在项目根目录执行：

```bash
cp .env.example .env && docker compose up -d --build
```

停止服务：

```bash
docker compose down
```

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 前端框架 | Vue 3 + TypeScript |
| 构建工具 | Vite 5 |
| UI 组件 | Element Plus |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 |
| 本地数据 | Dexie 4 + IndexedDB |
| 容器 | Nginx Alpine + Docker Compose |

## 访问地址

浏览器打开：`http://localhost:21808`

如修改 `.env` 中的 `FRONTEND_PORT`，请使用修改后的端口。

## 本地开发方式

```bash
cd frontend
npm install
npm run dev
```

开发服务器默认地址为 `http://localhost:5173`。生产构建检查使用：

```bash
cd frontend
npm run build
```

## 目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── README.md
└── frontend
    ├── Dockerfile
    ├── nginx.conf
    └── src
        ├── components/common   # 曲线、稀释、推拉标签与筛选组件
        ├── hooks               # 配方筛选与温度补偿
        ├── pages               # 五个业务页面
        ├── router              # 路由配置
        ├── stores              # 四类数据的 Pinia 状态与持久化动作
        ├── types               # 胶片、显影液、配方、冲洗记录模型
        └── utils               # Dexie 数据层、比例换算、JSON 导出
```

## 数据存储说明

- IndexedDB 数据库名：`gbfilmdev-db`
- Dexie 版本：`version(1)` 创建 `films`、`developers`、`recipes`、`runs` 四张表并建立常用查询索引。
- 迁移：`version(2).upgrade(...)` 为已有记录回填 `schemaRev: 2`；`version(3)` 新增 `ledger` 用液台账表（`[batchNo+kind]` 唯一复合索引），升级时按现有冲洗记录逐批次补齐占用，来源缺失的记录以 `unknown` 来源保留且不扣减，并把工作液账面 `usedRolls` 重算为台账净占用。首次打开数据库时通过 `populate` 写入丰富的胶片、显影液、配方、实冲记录及配套台账。
- 用液台账规则：每次确认实冲在同一事务内写入 run 与一条 `occupy` 占用；撤销实冲不删原记录，而是追加一条 `reverse` 冲正返还余量；同批次重复提交由唯一索引拦截，不会多扣。余量以台账净占用为准，达到 `maxRolls` 上限或瓶身已报废时新记录会被拦下；两个标签页并发提交同一批号时后提交方收到「已被占用」错误且不写入，瞬时写入失败自动回滚并重试。
- 数据保存在当前浏览器，不随容器重建而丢失；更换浏览器或清理站点数据前，可在顶部导航点击“导出数据”下载 JSON 备份（含台账流水）。
- 所有新增和更新动作在写入 Dexie 前均会去除响应式代理，避免 `DataCloneError`。
- 台账相关的运行时校验可在 `frontend` 下执行 `npm run verify:ledger`（基于 fake-indexeddb 覆盖占用、冲正、上限、并发与 v2→v3 迁移）。

## 核心功能与路由表

| 路由 | 页面标题 | 核心功能 |
| --- | --- | --- |
| `/` | 参数速查台 | 按胶片、稀释比、推拉档检索参数，查看最近冲洗记录 |
| `/films` | 胶片型号与乳剂批次台账 | 登记乳剂批次，按画幅和有效期筛选，观察余量 |
| `/developers` | 显影液配制与余量 | 登记工作液、换算容量、查看剩余可冲卷数并标记报废 |
| `/recipes` | 配方表 | 编排配方，按胶片和稀释比筛选，改温度即时重算时间 |
| `/runs` | 冲洗记录与结果评价 | 录入实冲温度与时间，查看补偿建议并回写配方注释 |

未匹配的路由会重定向到 `/`。
