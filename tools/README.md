# tools 目录说明

这些是**排查和开发用的脚本**，平时不用管。但当番茄改版、脚本突然认不出页面元素时，它们就是最快的定位工具。

## 最常用的两个

| 脚本 | 用途 | 怎么跑 |
|---|---|---|
| `probe-editor.js` | 打印章节编辑页的所有输入框/按钮/编辑器 | `node tools/probe-editor.js` |
| `check-login.js` | 检查浏览器能否启动、登录态是否有效 | `node tools/check-login.js` |

## 分卷相关（2026-10 新增）

| 脚本 | 用途 |
|---|---|
| `test-apply-volume.js` | **分卷切换自测**：直接调用生产的 `applyVolume()`，验证「切到第一卷 → 切回第二卷 → 幂等 → 拒绝不存在的卷」。改过分卷相关代码后跑一遍：`node tools/test-apply-volume.js` |
| `test-resolve-book.js` | **多书定位自测**：22 个断言覆盖 `listBooks` / `resolveBook` / `applyResolvedBook` / `getMaxChapterNo`，含"书名打错""写死地址指向另一本书""bookName 为空""autoFindBook=false"等失败路径。**纯只读，不会建草稿** |
| `diag-volume-picker.js` | **分卷弹窗诊断**：番茄改版导致切卷失败时用它。会打印弹窗的真实 DOM，并依次尝试 locator 点击 / 真鼠标 down-up / 键盘三种方式，同时记录相关网络请求 |
| `test-progress-index.js` | **发布记录识别自测**：37 个断言，验证"按标题认"和"按章节序号认"两条通道。**纯离线**（账本注入 + 最后一段只读真实账本）、不碰浏览器：`node tools/test-progress-index.js` |
| `test-browser-detect.js` | **浏览器探测自测**：87 个断言，验证"哪些浏览器被认出来""候选顺序对不对""慢速扫描""登录态目录分组"，以及**"依赖没装时第一眼看到的提示"**（会真起一个子进程跑 `browsers`，确认它不再建议一条跑不通的命令）。**纯离线**（环境变量、文件存在性、目录树都是假的）：`node tools/test-browser-detect.js` |
| `test-browser-launch.js` | **浏览器启动链路自测**：真去启动浏览器（无头、不弹窗），验证 Chrome / Edge / 自带内核都能起、坏掉会回退、报错文案里有下一步。改过 `src/browser.js` 或 `src/browser-detect.js` 就跑这个：`node tools/test-browser-launch.js` |
| `test-books.js` | **多书支持自测**：87 个断言，验证"每本书一份独立账本""列书/选书/报错文案""老布局迁移（备份+校验条数）"，以及**书籍概览的纯函数**（`summarize` / `pendingOf` / `clearCurrent` —— 含"这两个只读函数不许改动 `books/.current`"这条关键断言）。**纯离线**，全在临时目录里造数据，跑完自动清理：`node tools/test-books.js` |
| `_shared.js` | **不是独立脚本**，是上面这些脚本共用的浏览器启动封装（`openBrowser`）。★ 别在各个脚本里自己写 `channel: 'chrome'` —— 那样每加一个脚本就多一处"只认 Chrome"的硬编码 |

> 浏览器机制备忘：`src/browser-detect.js` 负责"这台机器上有哪些浏览器"（纯文件系统判断，
> **不依赖 playwright**，所以能离线单测），`src/browser.js` 负责"按顺序试着启动、坏一个换下一个"。
> 候选顺序 = 手填 exe → 配置指定的 channel → 自动认出来的（Chrome 起）→ 自带内核。
> 登录态目录按浏览器分开：`.browser-id.json` 记着 `userdata\` 属于谁，换浏览器就用 `userdata-<id>\`。

> 分卷机制备忘：点顶栏 `.publish-header-volume-wrap` 弹出的是**带「确定」按钮的弹窗**
> （`.serial-modal.editor-volume.byte-modal`）。点卷名只是打 `selected` 高亮，
> **必须再点 `.editor-volume-footer-buttons button.byte-btn-primary`（确定）** 才生效。
> 漏了点「确定」的症状就是"日志说选中了，但顶栏没变"。
>
> ★ 另外：**进编辑页后要等顶栏渲染完**再去读卷名。刚 goto 过去时控件可能还没画出来，
> 读不到就判"没有分卷控件"会让**每一章都发不出去**。生产代码里是 `waitForVolumeControl()`。

> 多书机制备忘：`src/books.js` 管 `books/<书名>/`，一本书一个文件夹。
> 每个命令在跑之前都会调 `books.activate()`，把 **progress / split / daily 三个模块的路径**
> 指到"当前那本"（`books/.current`）。
>
> ★★ **一本一份 `progress.json` 是硬要求，不是洁癖**：进度判定有一条"按章节序号认"的兜底通道
> （标题改了也能认出已发）。共用一份账本时，第二本书的「第17章」会命中第一本的「第17章」记录，
> 判成"已发布"**直接跳过且不报错**。实测复现过。
>
> ★ 老布局（单书、文件在根目录）会在任何命令启动时**自动迁移**，顺序是
> 「先备份到 `data/_迁移备份-<时间>/` → 再移动 → 再校验条数」，对不上就停下报错。
> 那些发布记录里有一半是用户手动发布后补的，重建不回来 —— 所以这步绝不能静默。
>
> ★ 三个模块的路径都是 `let` + `setFile()/setChaptersDir()`，**不要改回 `const` 写死**。
> `tools/test-books.js` 里有静态断言钉着这一点。
>
> ★ `cfg._book` 存的是 `describeBook()` 的**完整对象**（含各条路径），别改成只存 `{name, dir}` ——
> 自检里要取 `.progressPath`，缺字段会让 `path.relative(ROOT, undefined)` 直接抛错（踩过）。

## 本地面板（`src\ui\`）怎么排查

面板 = `src\ui\server.js`（零依赖 http 服务）+ `src\ui\public\`（原生 DOM 页面）。启动：`node src\ui\server.js`。

```bash
node src\ui\server.js --port 8787 --no-open     起服务（--no-open 不开浏览器）
curl --noproxy '*' http://127.0.0.1:8787/api/state   当前那本的详细状态（含"点一次会发几章"）
curl --noproxy '*' http://127.0.0.1:8787/api/books   ★ 所有书的概览（「书籍总览」用）
```

接口一览：

| 接口 | 说明 |
|---|---|
| `GET /api/state` | 当前那本：章节表、四张卡、`plan`（本次会发几章） |
| `GET /api/books` | **所有书**的概览：进度 / 待发 / 今日额度 / 最后发布 / 每本的 `plan` |
| `GET /api/log` | SSE，子进程输出实时推过来 |
| `POST /api/run` | 单个命令，白名单 `publish / lint / split / check` |
| `POST /api/batch` | **批量排队**：`{books: [...], cmd: 'publish'｜'lint'}`，书名必须在 `books/` 里真实存在 |
| `POST /api/switch` `POST /api/newbook` `POST /api/dailyset` `POST /api/stop` | 切书 / 新建 / 校准额度 / 停止 |

★ **沙箱/代理环境里 `curl` 打本机必须加 `--noproxy '*'`** —— 否则会走 `http_proxy` 拿到 502（服务是好的，是测法不对）。
★ 用 `nohup ... &` 起的服务会被回收，改用工具的 `run_in_background`。

> ★★ **面板绝不能自己实现一遍发布逻辑**。所有"会改东西"的动作都是
> `spawn(process.execPath, [src/cli.js, cmd, ...args])` 起子进程 —— 只读状态才在进程内读。
> 原因：面板曾自己拼参数调 `applyDailyQuota`，把 `daily.summary()`（字段 `used`）当账本传进去，
> 而 `remaining()` 读的是 `led.chars` → `NaN` → **永不停止** → 显示"会发 7 章"而实际一章都发不了。
> 语法检查和单测都发现不了，因为算出来的是个"看起来合理"的数字。
> 现在收敛成 `publisher.planNextRun(cfg, pending, quota, logger)`，**自检和面板共用**。
> ★ 写「书籍总览」时**又差点踩一次**：`planNextRun` 收的账本是 `{ used }`（`daily.summary()` 的形状），
> 不是 `{ chars }`。传错了 `remain` 会算成满额度 → 显示"会发 7 章"。
> 发现方式是拿 `/api/books` 的 `usedToday` 和 `plan.remaining` 对了一下，对不上。
> **所以 `planNextRun` 那个参数名 `quota.used` 是个陷阱，改它之前先看这段。**

> ★★ **只读接口不许有副作用**。`/api/books` 要遍历每本书算统计，
> 但**绝不能循环调 `books.activate()`** —— 它会 `setCurrent()` 重写 `books/.current`，
> 中途抛错就把「当前小说」留在别的书上了，用户下次点发布会发错书。
> 所以走的是 `books.summarize()` / `books.pendingOf()`：纯读文件，账本靠 `matchDone(title, no, data)` 注入。
> `test-books.js` §9 有一条断言专门钉这个。

> ★ 面板只监听 `127.0.0.1`（它能真把章节发出去，不能暴露到局域网）；命令白名单只有
> `publish / lint / split / check`；同一时刻只允许一个任务（重复触发返回 409）。
> 批量队列期间**整条队列算一个任务** —— 队列每步之间 `running` 会短暂为 null，
> 所以"忙不忙"看的是 `running || queue`，不然别的动作会趁虚而入、或者「停止」会说"没有任务在跑"。

## 全部脚本

| 脚本 | 作用 |
|---|---|
| `check-login.js` | 自检：浏览器启动 + 登录状态检测 |
| `probe.js` | 通用探查，可传任意网址：`node tools/probe.js <url>` |
| `probe-login.js` | 登录页结构 + 密码登录切换的**对照实验** |
| `probe-writer.js` | 作家后台首页（作品列表、入口按钮） |
| `probe-editor.js` | 章节编辑页（标题框、正文编辑器、提交按钮） |
| `probe-publish-flow.js` | 点「下一步」之后的发布流程（**不会点最终确认**） |
| `probe-chapter-manage.js` | 章节管理页（章节列表、字数、状态） |
| `check-drafts.js` | 草稿箱内容 |
| `test-autologin.js` | 单独测试自动登录 |
| `test-apply-volume.js` | 分卷切换自测 |
| `test-resolve-book.js` | 多书定位自测（22 断言，纯只读） |
| `test-progress-index.js` | 发布记录识别自测（37 断言，纯离线） |
| `test-books.js` | 多书支持自测（92 断言，纯离线，临时目录里造数据；含书籍概览纯函数与「额度是账号级」的静态断言） |
| `test-browser-detect.js` | 浏览器探测自测（87 断言，纯离线，不碰真实磁盘；含"缺依赖时的提示文案"） |
| `test-browser-launch.js` | 浏览器启动链路自测（真启动，无头不弹窗；含回退与报错文案） |
| `diag-volume-picker.js` | 分卷弹窗结构诊断 |
| `clean-junk-drafts.js` | 清理探查留下的垃圾草稿（**白名单匹配 + 默认预演**，加 `--yes` 才真删） |
| `_shared.js` | 上面脚本共用的浏览器启动封装（`openBrowser`），不是独立脚本 |

> `clean-junk-drafts.js` 的用法：先 `node tools/clean-junk-drafts.js` 看它打算删哪些，
> 确认无误再加 `--yes`。它只删名字里含「未命名草稿」或「【测试】分卷探查请忽略」的草稿，
> 其余一律不碰。

## 它们都会留下诊断文件

跑完后到 `logs\` 目录看：

- `logs\structure-*.json` —— 页面上所有元素的清单（tag、placeholder、class、文字、尺寸）
- `logs\shot-*.png` —— 当时的页面截图
- `logs\probe.json` / `writer-home.json` / `editor-page.json` 等 —— 各类探查结果

**出问题时，把 `logs\` 里的文件发出来，就能快速定位是哪一步的识别规则需要更新。**

## 注意

- 这些脚本都会**打开真实的浏览器窗口**（用 `userdata\` 里的登录态），属于正常现象。浏览器由 `_shared.js` 自动挑（不写死 Chrome）。
- ★ 需要读小说/账本的脚本，靠 `books.resolveBook()` 找"当前那本"（`books\.current`）。**别自己拼 `data\progress.json` 这种老路径** —— 多书改造后那些文件已经搬到 `books\<书名>\` 下了。
- `probe-editor.js` 和 `probe-publish-flow.js` 会在你的书里创建一个**空草稿章节**（番茄打开"创建章节"页就会生成）。
  跑完记得去后台 `章节管理 → 草稿箱` 删掉。
- 它们都是**只读为主**，唯一会碰页面的操作是切换标签页、填测试文字，**不会点发布**。
