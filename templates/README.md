# templates —— 配置模板

这个目录里的文件**不会被脚本读取**，它们只是样板。想用就**复制到指定位置、改个名**。

| 模板 | 复制成 | 什么时候需要 |
|---|---|---|
| `config.example.json` | 上一级目录的 `config.json` | 想改发布参数（每日字数上限、间隔秒数、用哪个浏览器…）时才需要。**不复制也能跑**，脚本会用内置默认值 |
| `credentials.example.json` | 上一级目录的 `credentials.json` | 想让脚本自动登录。**不建也行** —— 双击 `1-首次登录.bat` 手动登一次，登录状态一样会保留 |
| `book.example.json` | `books\<你的书名>\book.json` | 一般**不用手动复制**：双击 `11-切换当前小说.bat` 输入 `0` 新建时，脚本会自动生成一份 |

## 为什么这些文件要单独放

因为它们是**每个使用者自己的东西**，不应该跟着仓库走：

- `credentials.json` 里有账号密码
- `book.json` 里有你在平台上的书籍 ID
- `config.json` 里有你自己的发布节奏和平台额度

仓库的 `.gitignore` 已经把这三个**真实文件**排除在外了，所以从仓库里 clone 下来是干净的，
不会带上别人的账号或小说。

## 三个文件的最小可用版本

### `config.json`
**可以完全不建。** 脚本找不到它就用内置默认值（只是会打一句 `[WARN] 未找到 config.json，使用默认配置`）。
只在想调整参数时才复制 `config.example.json`。

### `credentials.json`
```json
{ "phone": "你的登录手机号", "password": "你的密码" }
```

### `books\<书名>\book.json`
```json
{ "bookName": "番茄后台里的完整书名", "sourceFile": "novel.txt" }
```

`bookUrl` / `createChapterUrl` 留空即可 —— 脚本会按 `bookName` 去作品管理页找，
自动拿到书籍 ID。想看看账号里有哪些书、准确书名是什么：

```bash
node src\cli.js books
```
