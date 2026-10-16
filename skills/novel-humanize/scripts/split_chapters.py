#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单文件小说拆章工具：把整本 novel.txt 按"第X章"标题切成逐章文件，供去 AI 味流程使用。

用法:
    python split_chapters.py <小说文件.txt> --list
    python split_chapters.py <小说文件.txt> --out <输出目录> [--from 17] [--to 30]

    --list        只列出识别到的章节（序号、标题、字数），不写文件
    --out DIR     输出目录（不存在则创建），每章一个 txt 文件
    --from N      起始章号（含），默认从头
    --to N        结束章号（含），默认到末

说明:
    - 自动识别编码（utf-8 / gbk）；
    - 标题格式支持"第17章""第十七章""第17章 标题""第17回"等；
    - 输出文件名形如 0017-第17章_深海要塞.txt，文件内容保留原标题行；
    - 不修改原文件。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

HEADING_RE = re.compile(
    r"^\s*第\s*([0-9]+|[零〇一二两三四五六七八九十百千万]+)\s*[章回][^\n]*$", re.M
)
INVALID_FN = re.compile(r'[\\/:*?"<>|\s]+')

CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}
CN_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}


def cn2num(text: str) -> int:
    if text.isdigit():
        return int(text)
    result = section = number = 0
    for ch in text:
        if ch in CN_DIGITS:
            number = CN_DIGITS[ch]
        elif ch in CN_UNITS:
            unit = CN_UNITS[ch]
            if unit == 10000:
                section = (section + number) * unit
                result += section
                section = 0
            else:
                if number == 0:
                    number = 1
                section += number * unit
            number = 0
        else:
            return 0
    return result + section + number


def read_text(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def find_chapters(text: str) -> list[dict]:
    chapters: list[dict] = []
    for m in HEADING_RE.finditer(text):
        heading = m.group(0).strip()
        num = cn2num(m.group(1))
        chapters.append({"num": num, "heading": heading, "start": m.start()})
    # 目录区去重：同一标题在很近距离内连续出现（目录行连排）时只保留每对中的实际正文标题
    dedup: list[dict] = []
    for ch in chapters:
        if dedup and ch["heading"] == dedup[-1]["heading"] and ch["start"] - dedup[-1]["start"] < 100:
            continue
        dedup.append(ch)
    return dedup


def main() -> int:
    parser = argparse.ArgumentParser(description="按章拆分小说单文件（不修改原文件）")
    parser.add_argument("file", help="整本小说文件（txt）")
    parser.add_argument("--list", action="store_true", help="只列出章节，不写文件")
    parser.add_argument("--out", help="输出目录")
    parser.add_argument("--from", dest="start_num", type=int, default=None, help="起始章号（含）")
    parser.add_argument("--to", dest="end_num", type=int, default=None, help="结束章号（含）")
    args = parser.parse_args()

    path = Path(args.file)
    if not path.is_file():
        print(f"找不到文件: {path}")
        return 1

    text = read_text(path)
    chapters = find_chapters(text)
    if not chapters:
        print("未识别到任何章节标题（支持：第17章 / 第十七章 / 第17回 等）")
        return 1

    for i, ch in enumerate(chapters):
        end = chapters[i + 1]["start"] if i + 1 < len(chapters) else len(text)
        ch["end"] = end
        ch["chars"] = len(re.findall(r"[\u4e00-\u9fff]", text[ch["start"]:end]))

    print(f"文件: {path.name}   识别到 {len(chapters)} 章")
    preface = text[: chapters[0]["start"]]
    pre_chars = len(re.findall(r"[\u4e00-\u9fff]", preface))
    if pre_chars > 50:
        print(f"（卷首有约 {pre_chars} 字的非章节内容，未计入任何章）")
    print()

    if args.list or not args.out:
        for i, ch in enumerate(chapters):
            print(f"  [{i + 1:>4}] 第{ch['num']}章  {ch['chars']:>6}字  {ch['heading'][:50]}")
        if not args.out:
            print("\n（未指定 --out，仅列出；加 --out <目录> 导出拆分文件）")
        return 0

    sel = chapters
    if args.start_num is not None:
        sel = [c for c in sel if c["num"] >= args.start_num]
    if args.end_num is not None:
        sel = [c for c in sel if c["num"] <= args.end_num]
    if not sel:
        print("指定范围内没有章节。")
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for ch in sel:
        name = INVALID_FN.sub("_", ch["heading"])[:48]
        filename = f"{ch['num']:04d}-{name}.txt"
        body = text[ch["start"]:ch["end"]].strip() + "\n"
        (out_dir / filename).write_text(body, encoding="utf-8")
        total += ch["chars"]
        print(f"  {filename}  ({ch['chars']}字)")
    print(f"\n已导出 {len(sel)} 章，共约 {total} 字 -> {out_dir}")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    raise SystemExit(main())
