# skills

配套 AI 技能包目录（Agent Skills）。

## novel-humanize — 小说"去 AI 味"与情感增强

把 AI 辅助稿改成"像人写的"，能力分三层，可独立使用也可串行：

| 层 | 管什么 | 文件 |
| --- | --- | --- |
| 字句层 | AI 腔、句式、节奏、高频词 | `references/ai-flavor-checklist.md` |
| 叙事层 | 设定漂移、伏笔、对话同质化、视角 | `references/fiction-craft.md` |
| 情节层 | 主线、冲突、情绪曲线、期待与收益节奏 | `references/plot-craft.md` |

另含：网文爽文修订专项（`webnovel-craft.md`）、情感增强（`emotion-enhance.md`）、诊断报告模板（`revision-report.md`）。

**本地工具（纯 Python，不联网）**：

```bash
python scripts/split_chapters.py <小说.txt> --list          # 查看章节结构
python scripts/split_chapters.py <小说.txt> --out chapters/ # 拆章
python scripts/scan_ai_flavor.py <文件或目录> --csv 报告.csv  # AI 味扫描
```

**安装**：把 `novel-humanize/` 整个目录复制到你所用的 Agent Skills 目录即可：

- WorkBuddy：`~/.workbuddy/skills/novel-humanize/`
- Claude Code：`~/.claude/skills/novel-humanize/`

安装后直接说"帮我去 AI 味 / 给修改建议 / 看看情节"即可触发。
