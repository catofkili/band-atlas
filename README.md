# 乐队关系网 · Band Atlas

**<https://catofkili.github.io/band-atlas/>**

从一支乐队出发，顺着成员流动、客串合作、影响与恩怨，一支一支走下去。

进站随机落在一支乐队上，它在屏幕正中完整展开；与它有关系的乐队贴在屏幕四周，
每张只露出一半，用带颜色的线牵着。点边缘的卡片，镜头滑过去，它展开成新的焦点，
它自己的邻居再从新的屏幕边缘探出头来。

**1018 支乐队与音乐人 / 2372 条关系**，平均每位 4.7 条；其中东亚 457 位，地区未知 54 位。
骨架由 MusicBrainz 爬来，现代日本增量同时允许组合与个人音乐人，简介取自维基百科；55 支由人工完整打底，
另有 15 条带来源的故事稿通过审核入库——包括数据库里根本没有的恩怨。

## 跑起来

```bash
python3 -m http.server 8790
```

然后打开 <http://localhost:8790>。线上仍是纯静态站，没有后端。
（用模块化 JS，所以必须走 http，`file://` 打不开。）

改完数据源之后重新生成每支乐队的 JSON：

```bash
npm install
npm run build
```

## 发布

推到 `main` 就会自动更新线上站点（GitHub Pages，从仓库根目录发布），一两分钟生效。

`dist/band-atlas.html` 是把样式、脚本和全部数据压进去的单文件版，零外部请求，
双击就能开，也能丢进禁止发请求的沙箱。改完内容重新生成：

```bash
npm run build
```

## 目录

```
index.html              外壳
style.css               全部样式（深色单主题）
js/
  main.js               舞台、相机、导航、搜索、路由
  map.js                读取离线坐标、四级预渲染、缩放与拖动
  layout.js             以焦点为中心的局部布局
  render.js             卡片与连线的 DOM
  data.js               按需加载 + 邻居预取
data/
  source/
    generated.json      爬来的，量大只有硬事实（勿手改）
    modern-japan.json   当代日本热门组合与个人音乐人（勿手改）
    artist-aliases.json MusicBrainz 正式别名、读音与罗马音（勿手改）
    intros.json         维基百科首段（勿手改）
    translations-zh.json DeepL 中文翻译缓存（不含密钥）
    zh-overrides.json   机器翻译明显失真时的人工中文校对
    influences.json     Wikidata P737 影响关系（勿手改）
    popularity.json     现有乐队的 ListenBrainz 历史收听与听众数
    wikidata-enrichment.json 现有乐队的流派与代表作品候选
    guest-edges.json    MusicBrainz 录音层客串 / 合作（勿手改）
    music-links.json    四个平台艺人主页、证据类型与待复核候选
    scene-jrock.json    人工整理，覆盖层：中文简介、轶事、恩怨
    greater-china.json  大陆、台湾、香港代表乐队精品卡与探索关系
  review/
    FEUD_REVIEW.md      恩怨情仇人工审核清单
    history-candidates.json 带中文稿、来源和状态的审核候选
    wikipedia-history-raw.json 三语 Wikipedia 关键词扫描原料
  bands/<id>.json       构建产物，每支乐队一份
  index.json            构建产物，随机进站与搜索用
  graph.json            构建产物，全网关系与固定 (x, y) 坐标
tools/
  crawl.mjs             爬 MusicBrainz，穿过乐手把乐队连起来
  fetch-popular-seeds.mjs ListenBrainz 全站收听量榜（热门度顺序）
  fetch-popularity.mjs  只给现有乐队补 ListenBrainz 热度
  fetch-modern-japan.mjs 核实并按热度加入当代日本音乐人
  fetch-artist-aliases.mjs 批量生成全局多文字搜索别名
  fetch-intros.mjs      Wikidata 找条目 → 维基百科取首段
  translate-zh.mjs      外文简介、地区、流派 → 简体中文翻译缓存
  fetch-influences.mjs  Wikidata P737「受谁影响」→ 只留网内关系
  fetch-wikidata-enrichment.mjs 补流派与代表作品候选
  fetch-guest-recordings.mjs 穿过录音与客串者补合作关系
  scan-wikipedia-history.mjs 生成恩怨情仇审核原料
  build-data.mjs        数据合并、展开双向边、生成离线地图
  lib/layout-graph.mjs  Graphology ForceAtlas2 + Noverlap
  check-layout.mjs      坐标、标签碰撞与关系线长度验收
  check-site.mjs        内容、地区、热度、单文件与缓存版本回归
  stamp-assets.mjs      用内容哈希统一静态资源缓存版本
  build-standalone.mjs  压成一个自包含 HTML
  lib/mb.mjs            限速、落盘缓存、重试
```

流媒体艺人主页单独保存在 `data/source/music-links.json`。人工链接与 Wikidata /
MusicBrainz 外部 ID 优先；平台搜索只有在名称唯一精确匹配，或同名候选能用已有专辑、
曲目唯一核对时才会写入。未能确认的平台会在卡片中标成“未找到主页”。

## 数据管线

```bash
npm run fetch:popularity                                      # 1042 支源数据的真实收听记录
npm run fetch:modern-japan                                    # 当代日本组合与个人音乐人
npm run fetch:aliases                                         # 正式名、假名、罗马音互查索引
npm run fetch:wikidata-enrichment                             # 流派、作品候选
npm run fetch:guests -- --east=1000 --western=40 --pages=3   # 东亚全覆盖、欧美热门组
npm run scan:wikipedia-history -- --east=100 --western=60    # 只生成审核原料
DEEPL_AUTH_KEY=... node tools/translate-zh.mjs                  # 只翻新增或源文变化
npm run build                                                   # 合并、离线布局、全套校验、单文件版
```

所有响应都缓存在 `.cache/`（已 gitignore），中断了重跑、或者改爬取策略再来一遍，
都不会重复打接口。目前自动扩张名单已停用；以上命令只丰富现有乐队，不会偷偷增加节点。

**穿过人来连乐队**是整条管线的关键一步。MusicBrainz 存的是「乐队 ↔ 乐手」，
而我们要的是「乐队 ↔ 乐队」：先取一支乐队的成员名单，再取每个成员待过的所有乐队，
凡是共享过同一个乐手的两支乐队之间就落一条边，标签写那个人的名字。
共享的乐手越多，这条关系越靠前。这正好就是「某支乐队的鼓手后来去了哪儿」。

**五层合并**，下层只填上层没写的字段：

| 层 | 来源 | 内容 |
|---|---|---|
| 底 | `generated.json` | MusicBrainz：名字、地区、年代、流派、专辑、成员流动 |
| 底 | `modern-japan.json` | 当代日本热门增量：Group + Person、专辑 / EP、热度推荐 |
| 中 | `artist-aliases.json` | MusicBrainz：正式别名、假名、罗马音搜索键 |
| 中 | `intros.json` | 维基百科首段（中文优先，外文随后统一翻译） |
| 中 | `translations-zh.json` | DeepL：把英日简介、地区和流派统一为简体中文 |
| 中 | `wikidata-enrichment.json` | Wikidata：补空白流派与代表作品候选 |
| 中 | `popularity.json` | ListenBrainz：历史收听量、独立听众数 |
| 中 | `guest-edges.json` | MusicBrainz 录音署名：客串、合作 |
| 高 | `zh-overrides.json` | 人工校正截断、错译和维基条目串线 |
| 顶 | `scene-jrock.json` | 人工：中文简介、代表曲、轶事，以及数据库里没有的恩怨 |
| 审核后 | `review/history-candidates.json` | 只有状态为 `approved` 的中文稿与红线才会并入 |

乐队 id 以人工那层为准——已经分享出去的链接（`#/band/straightener`）不能因为重跑数据就失效。

## 关系类型

| 类型 | 含义 | 线 |
|---|---|---|
| `member` | 成员流动：谁从哪支去了哪支 | 蓝 实线 |
| `guest` | 客串、合作、长年共演 | 绿 实线 |
| `influence` | 谁受谁影响 | 紫 实线 |
| `feud` | 恩怨：决裂、对峙、互喷 | 红 虚线 |
| `scene` | 同乡、同世代或明确标注的推荐 | 金 点线 |

`scene` 是比开发报告多出来的一档。它也承载明确标注的推荐边；成员和客串是硬事实，影响是半事实，
而「同一批人、同一个场景」这种关系真实存在、密度又高，单独一档比硬塞进
`influence` 诚实。

## 几个关键决定

**假的无限画布。** 看起来是一张走不完的大网，实现上不维护全局坐标——
沿关系链点十几步之后，真实坐标系里的节点会互相重叠、绕圈撞回来。
任意时刻世界里只有焦点（原点）和它的邻居。点击邻居时相机滑过去，
动画结束的那一帧把世界原点偷换成新焦点、重新布点。画面内容一致，看不出破绽。

**全网地图使用固定的离线坐标。** 构建脚本把关系数据交给 Graphology：
先按关系强度运行 ForceAtlas2（Barnes–Hut），再用 Noverlap 做标签碰撞收尾，
最后把不同连通分量确定性地装箱，并把 `(x, y)` 写进 `data/graph.json`。
浏览器不运行力导向，也不因焦点变化挪动节点；它只按四个固定层级画图、缩放和平移。
同一份数据重复构建会得到完全相同的坐标，便于分享与截图。

**八个邻居是一半固定、一半轮换。** 桌面端关系多于八条时，前四个由关系权重、
关系类型与对端内容量决定，固定展示；另外四个从其余关系中抽取。手机端对应为二加二。
尺寸变化不会让抽取结果乱跳，重新进入同一乐队才会换一批；来路乐队永远强制保留。

**热度筛选不删数据，而且默认开启。** 主页面与地图共用“隐藏冷门”开关，以
ListenBrainz 历史总收听 1000 次为基础门槛；开启时，随机换一支、焦点卡片、关系线、
边缘邻居、搜索结果和地图都不会把用户带进超冷门节点。公开收听库对华语平台覆盖不足，
因此人工核实过的大陆、台湾与香港代表乐队也保留显示，但不会伪造它们的收听量。
分享链接指定的当前焦点例外保留。ListenBrainz 只代表其开放数据用户提交的播放历史，
并不是 Spotify、Apple Music 等平台的全球总播放量。

**美国节点执行完整专辑准入。** 为了从成员履历图转向推歌，构建时会移除没有任何
可确认已发行完整录音室专辑的美国项目；EP、Demo、现场、精选和原声不能单独过关。
若删除临时项目使一支完整专辑乐队失去唯一关系，构建器会把原两跳链路折叠成明确标注的
金色推荐虚线，不把推荐冒充成员或合作事实。

**槽位沿边框走，不按角度均分。** 按角度分会出问题：宽屏上「离垂直方向 26°」
在水平方向只有几十像素，上下两张卡片会挤在焦点卡片正后方。按边长分则贴着边均匀铺开。
四个角留空——角上的卡片只露得出四分之一，而且四个角正是 HUD 所在的位置。

**露出哪半边，内容就贴哪半边。** 从右边探出的卡片看得见的是左半张，内容靠左；
从上面探出的看得见的是下半张，内容沉底。否则名字正好被切在屏幕外。

**来路乐队一定留下。** 邻居按权重截断，但刚才是从哪支过来的，那支无论权重多低都入选，
并且占据「来的方向」的反向槽位。既保证回得去，也保住空间记忆。

**搜索是全局多文字索引。** 搜索框不是只查当前邻居，而是一次搜索全部节点。
构建时把 MusicBrainz 的艺人别名预先展开为平假名、片假名和罗马音，因此
`藤井風`、`Fujii Kaze`、`ふじいかぜ`、`フジイカゼ` 会落到同一位音乐人；
汉字互通取决于 MusicBrainz 是否收录对应别名，不做容易误伤的自动猜读。

**关系标签放不下就收起来。** 标签挂在焦点卡片外缘往外长（居中的话靠内那半截会被卡片盖住）。
左右两条边够长挂得下；上下两条边焦点卡片几乎顶到视口边沿，没有缝——那种情况标签收起，
改由邻居卡片自己写出关系。判断用的是标签展开后的尺寸，避免收起时放得下、一悬停就撞车。

**后台标签页的兜底。** `requestAnimationFrame` 和 WAAPI 动画在不渲染的标签页里不推进。
入场动画的起始态、相机平移的完成回调都各挂了一个定时器兜底，否则页面会停在全透明，
或者导航卡在半路再也点不动。

## 接下来

- **新增乐队**：目前不自动扩张；本轮现代日本增量按 Billboard Japan 年榜候选核实，
  再用 ListenBrainz 历史收听量排序。需要时人工启动，不会后台偷偷增加节点。
- **影响关系**：Wikidata `P737` 已接入；它覆盖不均，且只收两端都在本网内的关系，人工补充仍然很重要。
- **客串关系**：录音层已有带 MusicBrainz 录音 URL 的候选，当前全图有 114 条客串边。
- **专辑封面**：Cover Art Archive，构建期生成缩略图存同源。
- **恩怨**：160 支热门乐队的三语 Wikipedia 已跑出 63 个原始条目，并整理成 15 条中文稿；
  其中 10 条东亚、2 条形成站内双端红线。这批内容现已审核入库，卡片同时显示来源链接。

## 数据准确性

爬来的部分（名字、年代、专辑、成员流动）以 MusicBrainz 为准，硬事实可靠，
但覆盖不均。当前 672 位有流派、346 位有代表曲；332 位简介仍标记为机器事实摘要，
这些摘要会给出作品入口和最重要的成员关系，但不会冒充人工内容，也不会进入高质量随机首屏池。
随机入口只从非模板、关系不少于三条的高质量候选中选择。它先按
东亚 55% / 非东亚 45% 抽取地区，再把同地区热度换算成百分位：
中上知名度（约第 68 百分位）出现最多，顶流仍明显高于最冷门乐队，但不会垄断入口。
内容越完整的精品卡会得到额外权重，最近随机出现过的 14 支则暂时降权，避免重复刷屏。

`scene-jrock.json` 里人工写的简介、代表曲、轶事未经数据库校验，细节可能有出入。
恩怨类条目只收录有公开报道的事件，措辞保持中性。

爬取沿着「共享乐手」往外走，走到哪儿由数据密度决定而不是曲风——
所以除了日本另类摇滚，还会连出九十年代美国另类摇滚、工业、硬摇滚的一大片。
这些连接都是真的，只是场景不再单一。
