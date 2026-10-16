#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 味扫描器：词表 + 结构模式 + 量化指标（本地统计，不联网、不修改任何文件）。

用法:
    python scan_ai_flavor.py <文件或目录> [--per-file] [--csv 报告.csv] [--top 15]

    <文件>  单个文件的完整报告
    <目录>  批量扫描目录下的 .txt / .md（像逐章扫描整本书）：
            默认输出"每章一行摘要 + 全书汇总 + 需优先处理的章节列表"；
            --per-file  额外打印每章的完整报告；
            --csv       导出逐章指标表（utf-8-sig，Excel 可直接打开）。

输出指标:
    词表命中密度 / 不是X而是Y / 三项排比 / "的"字链 / 连续长句 / 连续同代词开头 /
    破折号 / 感叹号 / 问号 / 省略号 / 弱化副词 / 句长基准（自然 20-30 字）/
    短句占比 / 段落中位 / 工程词泄漏 / 句长波动 CV / 对话段占比

参考线为小说档启发式（源自 人味 renwei 的虚构类阈值），仅作诊断线索，
标准见 references/ai-flavor-checklist.md。
"""
from __future__ import annotations

import argparse
import csv
import re
import statistics
import sys
from pathlib import Path

BLACKLIST: dict[str, list[str]] = {
    "万能副词": [
        "不禁", "不由得", "下意识", "缓缓", "轻轻", "淡淡", "微微",
        "静静", "默默", "深深", "渐渐", "顿时", "刹那", "瞬间", "悄然",
    ],
    "情绪直述": [
        "五味杂陈", "心如刀绞", "心潮澎湃", "热血沸腾", "难以言喻",
        "无以言表", "无法形容", "前所未有的", "莫名的", "复杂的心情",
        "复杂的情绪", "涌上心头", "百感交集", "心头一颤",
    ],
    "模板比喻": [
        "如遭雷击", "五雷轰顶", "断了线的风筝", "坠入深渊", "受伤的野兽",
        "如同潮水", "像潮水般", "仿佛整个世界", "心像被撕裂", "刀割一般", "仿佛",
    ],
    "氛围套话": [
        "空气中弥漫", "剑拔弩张", "落针可闻", "鸦雀无声", "死一般的寂静",
        "诡异的氛围", "阴森恐怖", "危险的气息", "时间仿佛静止", "空气仿佛凝固",
    ],
    "升华收尾": [
        "这一刻", "终于明白", "终于懂得", "也许这就是", "或许这就是",
        "命运的齿轮", "命运的轮盘",
    ],
    "解释连接": [
        "这让他意识到", "这让她意识到", "他意识到", "她意识到",
        "这意味着", "换句话说", "事实上",
    ],
    "对话书面腔": [
        "地说道", "缓缓说道", "轻声说", "轻声道", "顿了顿",
        "沉吟片刻", "话音未落", "冷冷地说",
    ],
    "议论文腔": [
        "值得注意", "值得一提", "不容忽视", "不可否认", "毋庸置疑",
        "显而易见", "综上所述", "总而言之", "换言之", "在此背景下", "与此同时",
    ],
    "欧化公文腔": [
        "进行了", "作出了", "给予了", "作为一个", "的情况下", "的过程中",
    ],
    "战报腔/夸张词": [
        "轰然", "骤然", "悍然", "陡然", "死死", "整整", "惊天", "震天",
        "滔天", "摧枯拉朽", "灰飞烟灭", "死寂", "彻底",
    ],
    "解释腔上帝视角": [
        "殊不知", "多年以后", "冥冥之中", "仿佛预示", "不难看出", "由此可见",
        "此时此刻", "映入眼帘", "不由自主", "只见", "心中暗道", "目光如炬",
        "脸色一变", "嘴角微扬", "嘴角勾起",
    ],
    "套式反应": [
        "深吸一口气", "眼中闪过", "指节泛白", "缓缓开口",
    ],
}

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
SENT_SPLIT_RE = re.compile(r"[。！？!?…]+")
RE_STRAWMAN = re.compile(r"不是[^，。；！？]{1,20}[，,]?而是")
RE_TRIAD = re.compile(r"[^，。；！？、\s]{1,9}、[^，。；！？、\s]{1,9}、[^，。；！？、\s]{1,9}[，。；！？]")
RE_DASH = re.compile(r"—+")
RE_EXCL = re.compile(r"[！!]")
RE_QUES = re.compile(r"[？?]")

PRONOUNS = "他她我它"


def read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "gbk", "gb18030"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="ignore")


def sentences_of(text: str) -> list[str]:
    return [s.strip() for s in SENT_SPLIT_RE.split(text) if CJK_RE.search(s)]


def count_runs(flags: list[bool], min_len: int = 3) -> tuple[int, int]:
    """统计连续 True 的段数（每段长度 >= min_len），返回 (段数, 最长段长)。"""
    runs, longest, cur = 0, 0, 0
    for f in flags:
        if f:
            cur += 1
            longest = max(longest, cur)
        else:
            if cur >= min_len:
                runs += 1
            cur = 0
    if cur >= min_len:
        runs += 1
    return runs, longest


def same_pronoun_runs(sents: list[str]) -> tuple[int, int]:
    """连续句首为同一代词（他/她/我/它）的段数，段长 >= 3 计一处。"""
    runs, longest, cur, prev = 0, 0, 0, None
    for s in sents:
        first = s[0] if s else ""
        if first in PRONOUNS and first == prev:
            cur += 1
        else:
            if cur >= 3:
                runs += 1
            cur = 1 if first in PRONOUNS else 0
        longest = max(longest, cur)
        prev = first
    if cur >= 3:
        runs += 1
    return runs, longest


def analyze(text: str) -> dict:
    sents = sentences_of(text)
    cjk = len(CJK_RE.findall(text))
    chars = max(cjk, 1)
    per_k = lambda n: n * 1000.0 / chars  # noqa: E731

    lengths = [len(CJK_RE.findall(s)) for s in sents]
    if lengths:
        mean = statistics.fmean(lengths)
        cv = (statistics.pstdev(lengths) / mean) if mean > 0 and len(lengths) > 1 else 0.0
    else:
        mean, cv = 0.0, 0.0

    paragraphs = [p.strip() for p in text.splitlines() if p.strip()]
    dialogue = [p for p in paragraphs if ("\u201c" in p) or ('"' in p)]
    dialogue_pct = (len(dialogue) / len(paragraphs) * 100.0) if paragraphs else 0.0

    word_hits: dict[str, tuple[int, list[tuple[str, int]]]] = {}
    total = 0
    all_hits: list[tuple[str, int]] = []
    for cat, words in BLACKLIST.items():
        cat_hits: list[tuple[str, int]] = []
        for w in words:
            c = text.count(w)
            if c:
                cat_hits.append((w, c))
                all_hits.append((w, c))
        if cat_hits:
            n = sum(c for _, c in cat_hits)
            total += n
            cat_hits.sort(key=lambda x: -x[1])
            word_hits[cat] = (n, cat_hits)

    density = per_k(total)
    grade = "轻微" if density < 8 else ("中度" if density < 20 else "重度")

    strawman = len(RE_STRAWMAN.findall(text))
    triad = len(RE_TRIAD.findall(text))
    triad_pct = (triad / len(sents) * 100.0) if sents else 0.0
    de_sents = sum(1 for s in sents if s.count("的") >= 3)
    de_pct = (de_sents / len(sents) * 100.0) if sents else 0.0
    long_runs, long_max = count_runs([len(CJK_RE.findall(s)) > 35 for s in sents])
    pro_runs, pro_max = same_pronoun_runs(sents)
    dash = len(RE_DASH.findall(text))
    ellipsis = len(re.findall(r"…+", text))
    weak = sum(text.count(w) for w in ("微微", "淡淡", "缓缓", "轻轻"))
    eng_leak = [w for w in ("细纲", "情节点", "大纲", "设定集", "伏笔台账", "人物弧光") if w in text]
    short_sents = sum(1 for s in sents if len(CJK_RE.findall(s)) <= 5)
    short_pct = (short_sents / len(sents) * 100.0) if sents else 0.0
    para_cjk = [len(CJK_RE.findall(p)) for p in paragraphs]
    para_median = float(statistics.median(para_cjk)) if para_cjk else 0.0

    return {
        "chars": cjk,
        "sents": len(sents),
        "avg_len": mean,
        "cv": cv,
        "dialogue_pct": dialogue_pct,
        "word_hits": word_hits,
        "all_hits": all_hits,
        "word_total": total,
        "word_density": density,
        "grade": grade,
        "strawman": strawman,
        "strawman_k": per_k(strawman),
        "triad": triad,
        "triad_pct": triad_pct,
        "de_sents": de_sents,
        "de_pct": de_pct,
        "long_runs": long_runs,
        "long_max": long_max,
        "pro_runs": pro_runs,
        "pro_max": pro_max,
        "dash": dash,
        "dash_k": per_k(dash),
        "exclaim": len(RE_EXCL.findall(text)),
        "question": len(RE_QUES.findall(text)),
        "ellipsis": ellipsis,
        "weak": weak,
        "weak_k": per_k(weak),
        "eng_leak": eng_leak,
        "short_pct": short_pct,
        "para_median": para_median,
    }


def flags_of(m: dict) -> list[str]:
    """越线判定：兼顾密度与绝对数量，避免短文本误报。"""
    out: list[str] = []
    if m["sents"] >= 5 and m["cv"] < 0.55:
        out.append("句长偏均匀")
    if m["word_total"] >= 5 and m["word_density"] >= 20:
        out.append("词表重度")
    elif m["word_total"] >= 3 and m["word_density"] >= 8:
        out.append("词表中度")
    if m["strawman"] >= 3 and m["strawman_k"] > 1.0:
        out.append("不是X而是Y超标")
    if m["sents"] >= 10:
        if m["triad_pct"] > 10.0:
            out.append("三项排比超标")
        if m["de_pct"] > 15.0:
            out.append("的字链超标")
    if m["long_runs"] > 2 or m["long_max"] > 4:
        out.append("连续长句")
    if m["pro_runs"] > 2 or m["pro_max"] > 4:
        out.append("连续同代词")
    if m["dash"] >= 4 and m["dash_k"] > 3.0:
        out.append("破折号超标")
    if m["sents"] >= 30 and m["avg_len"] < 15:
        out.append("疑似电报体(句均过短)")
    elif m["avg_len"] > 32:
        out.append("句均偏长")
    if m["short_pct"] > 40:
        out.append("短句过多(电报体嫌疑)")
    if m["weak_k"] > 3.0:
        out.append("弱化副词超标")
    if m["eng_leak"]:
        out.append("工程词泄漏")
    return out


def print_full(name: str, m: dict, top: int) -> None:
    print("=" * 48)
    print(f"AI 味扫描报告 · {name}")
    print("=" * 48)
    print(f"正文汉字数 : {m['chars']}")
    band_ok = (15.0 <= m["avg_len"] <= 32.0) or m["sents"] < 10
    print(f"句子数     : {m['sents']}    平均句长: {m['avg_len']:.1f} 字  (自然基准 20-30；<15 疑似电报体){'' if band_ok else '  <- 注意'}")
    cv_ok = m["cv"] >= 0.55 or m["sents"] < 5
    print(f"句长波动CV : {m['cv']:.2f}   (越低越均匀；参考 >0.70 较自然){'' if cv_ok else '  <- 注意'}")
    print(f"短句占比   : {m['short_pct']:.0f}% (<=5字句；碎句成片=电报体，参考 <=40%)   段落中位: {m['para_median']:.0f} 字")
    print(f"对话段占比 : {m['dialogue_pct']:.0f}%   (仅作参考，随文风差异大)")
    print()

    if m["word_hits"]:
        for cat, (n, cat_hits) in m["word_hits"].items():
            detail = "  ".join(f"{w}x{c}" for w, c in cat_hits[:8])
            print(f"[{cat}] {n} 次 ({n * 1000.0 / max(m['chars'], 1):.1f}/千字)")
            print(f"    {detail}")
        print()
    else:
        print("[词表命中] 无\n")

    print(f"[词表汇总] 总命中 {m['word_total']} 次，密度 {m['word_density']:.1f}/千字  ->  评级: {m['grade']}")
    print("(参考线: <8 轻微 / 8-20 中度 / >20 重度)")

    print()
    print("[结构模式]")
    straw_ok = m["strawman"] < 3 or m["strawman_k"] <= 1.0
    print(f"  不是X而是Y        : {m['strawman']} 处 ({m['strawman_k']:.1f}/千字)  (参考 >=3处且 >1.0/千字 需清理){'' if straw_ok else '  <- 注意'}")
    triad_ok = m["sents"] < 10 or m["triad_pct"] <= 10.0
    print(f"  三项排比          : {m['triad']} 处 (占 {m['triad_pct']:.1f}% 句)  (参考 <=10%){'' if triad_ok else '  <- 注意'}")
    de_ok = m["sents"] < 10 or m["de_pct"] <= 15.0
    print(f"  \"的\"字链(>=3个)   : {m['de_sents']} 句 (占 {m['de_pct']:.1f}%)  (参考 <=15%){'' if de_ok else '  <- 注意'}")
    long_ok = m["long_runs"] <= 2 and m["long_max"] <= 4
    print(f"  连续3句超35字     : {m['long_runs']} 处 (最长连续 {m['long_max']} 句)  (参考 <=2 处且最长 <=4){'' if long_ok else '  <- 注意'}")
    pro_ok = m["pro_runs"] <= 2 and m["pro_max"] <= 4
    print(f"  连续同代词开头    : {m['pro_runs']} 处 (最长连续 {m['pro_max']} 句)  (参考 <=2 处且最长 <=4){'' if pro_ok else '  <- 注意'}")

    print()
    print("[标点]")
    dash_ok = m["dash"] < 4 or m["dash_k"] <= 3.0
    print(f"  破折号            : {m['dash']} 处 ({m['dash_k']:.1f}/千字)  (小说参考 <=3.0/千字，少量属正当用法){'' if dash_ok else '  <- 注意'}")
    print(f"  感叹号            : {m['exclaim']} 个     问号: {m['question']} 个")
    weak_ok = m["weak_k"] <= 3.0
    print(f"  弱化副词          : {m['weak']} 个 ({m['weak_k']:.1f}/千字，微/淡/缓/轻；参考 <=3/千字){'' if weak_ok else '  <- 注意'}")
    print(f"  省略号(……)        : {m['ellipsis']} 处   (按功能判断，不做硬禁令)")
    if m["eng_leak"]:
        print(f"  工程词泄漏        : 命中{'、'.join(m['eng_leak'])}   <- 正文不得出现工程词，需改成剧情内表达")

    if m["all_hits"]:
        hits = sorted(m["all_hits"], key=lambda x: (-x[1], x[0]))
        top_str = "  ".join(f"{w}x{c}" for w, c in hits[: max(top, 1)])
        print(f"\nTop 命中: {top_str}")

    fl = flags_of(m)
    if fl:
        print(f"\n越线项: {'、'.join(fl)}")

    if m["chars"] < 500:
        print("\n(文本较短，千字密度与百分比仅作参考，重点看命中的具体项)")

    print("\n提示: 以上只是线索，请结合 references/ai-flavor-checklist.md 逐维人工诊断；")
    print("     作者刻意的风格指纹、小说里的拟人修辞不算 AI 味。")


def line_for(name: str, m: dict) -> str:
    fl = flags_of(m)
    flag_str = ("；".join(fl)) if fl else "未见明显越线"
    return (
        f"{name} | {m['chars']}字 | 词表 {m['word_density']:.1f}/千字[{m['grade']}] | "
        f"不是X而是Y={m['strawman']} 排比={m['triad_pct']:.0f}% 的链={m['de_pct']:.0f}% "
        f"长句={m['long_runs']} 同代词={m['pro_runs']} | 破折号={m['dash_k']:.1f}/千字 | {flag_str}"
    )


CSV_HEADER = [
    "文件", "汉字数", "句子数", "平均句长", "句长CV", "对话段占比%",
    "词表命中", "词表密度/千字", "评级",
    "不是X而是Y", "三项排比", "排比占句%", "的链句数", "的链占句%",
    "连续长句处", "最长连续", "连续同代词处", "最长连续",
    "破折号", "破折号/千字", "感叹号", "问号", "越线项",
]


def write_csv(csv_path: str, rows: list[tuple[str, dict]]) -> None:
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(CSV_HEADER)
        for name, m in rows:
            w.writerow([
                name, m["chars"], m["sents"], f"{m['avg_len']:.1f}", f"{m['cv']:.2f}", f"{m['dialogue_pct']:.0f}",
                m["word_total"], f"{m['word_density']:.1f}", m["grade"],
                m["strawman"], m["triad"], f"{m['triad_pct']:.1f}", m["de_sents"], f"{m['de_pct']:.1f}",
                m["long_runs"], m["long_max"], m["pro_runs"], m["pro_max"],
                m["dash"], f"{m['dash_k']:.2f}", m["exclaim"], m["question"],
                "、".join(flags_of(m)),
            ])


def scan_directory(path: Path, args: argparse.Namespace) -> int:
    files = sorted(
        p for p in path.iterdir()
        if p.is_file() and p.suffix.lower() in (".txt", ".md")
    )
    if not files:
        print(f"目录下没有 .txt / .md 文件: {path}")
        return 1

    print(f"扫描目录: {path}   共 {len(files)} 个文件")
    print("-" * 48)

    rows: list[tuple[str, dict]] = []
    agg_chars = 0
    agg_words = 0
    for f in files:
        m = analyze(read_text(f))
        rows.append((f.name, m))
        agg_chars += m["chars"]
        agg_words += m["word_total"]
        print("  " + line_for(f.name, m))
        if args.per_file:
            print()
            print_full(f.name, m, args.top)
            print()

    density = agg_words * 1000.0 / max(agg_chars, 1)
    grade = "轻微" if density < 8 else ("中度" if density < 20 else "重度")
    print("-" * 48)
    print(f"[全书汇总] {len(files)} 个文件 · {agg_chars} 字 · 词表命中 {agg_words} 次 · 密度 {density:.1f}/千字 -> {grade}")
    print("(单章密度受篇幅影响，重点看每行括号里的评级与越线项)")

    flagged = [(n, flags_of(m)) for n, m in rows if flags_of(m)]
    if flagged:
        print(f"\n[需优先处理的章节] 共 {len(flagged)} 个（重灾章 / 前 3 章优先）")
        for n, fl in flagged:
            print(f"  - {n}: {'、'.join(fl)}")
    else:
        print("\n所有章节均未见明显越线。")

    if args.csv:
        write_csv(args.csv, rows)
        print(f"\nCSV 已导出: {args.csv}")

    print("\n提示: 结果用于排优先级，正式诊断请结合 references/ai-flavor-checklist.md；")
    print("     整本流程见 SKILL.md「整本 / 多章批量流程」。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="扫描小说文本的 AI 味线索（本地统计）")
    parser.add_argument("path", help="待扫描的文本文件或目录（目录扫描 .txt / .md）")
    parser.add_argument("--top", type=int, default=15, help="完整报告中展示的 Top 命中词数量")
    parser.add_argument("--per-file", action="store_true", help="目录模式下额外打印每章完整报告")
    parser.add_argument("--csv", help="把逐章指标表导出为 CSV 文件")
    args = parser.parse_args()

    path = Path(args.path)
    if path.is_dir():
        return scan_directory(path, args)
    if path.is_file():
        m = analyze(read_text(path))
        print_full(path.name, m, args.top)
        if args.csv:
            write_csv(args.csv, [(path.name, m)])
            print(f"\nCSV 已导出: {args.csv}")
        return 0
    print(f"找不到路径: {path}")
    return 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    raise SystemExit(main())
