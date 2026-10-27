"""Render completed validation candidates from their saved Ditto artifacts.

No model calls, dataset reads, gold labels, or test-set artifacts are used.
Run with a Python environment containing Pillow. --watch regenerates the report
when a candidate completes, and also writes an immutable per-candidate PNG.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


BG = "#f3f6fb"
INK = "#20344f"
MUTED = "#6d7f98"
TEAL = "#00868c"
GROUP = "#eaf1f9"
BORDER = "#d2dfee"
CAUTION = "#a85d12"
SMALL_BATCH_PROTOCOL = "generated-drop-small-batch-v1"
EXPANDED_SEARCH_PROTOCOL = "generated-drop-expanded-v2"
FROZEN_EXPANSION_PROTOCOL = "frozen-candidate-full200-expansion-v1"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def safe_sample_metrics(path):
    """Keep only telemetry fields; never retain prediction or judge fields."""
    keep = {"latencyMs", "providerAttempts", "usageKnown"}
    rows = []
    if path.exists():
        with path.open(encoding="utf-8-sig") as stream:
            for line in stream:
                if line.strip():
                    rows.append(json.loads(line, object_pairs_hook=lambda pairs: {
                        key: value for key, value in pairs if key in keep
                    }))
    return rows


def candidates(run_dirs):
    found = []
    for run in run_dirs:
        manifest = read_json(run / "manifest.json")
        def chronological_key(path):
            candidate_id = path.parent.name
            if candidate_id.startswith("seed-"):
                return (0, 0, candidate_id)
            if candidate_id.startswith("generated-") and candidate_id[10:].isdigit():
                return (1, int(candidate_id[10:]), candidate_id)
            return (2, 0, candidate_id)
        for summary_path in sorted((run / "evaluations").glob("*/summary.json"), key=chronological_key):
            candidate_id = summary_path.parent.name
            checkpoint_path = run / "checkpoints" / f"{candidate_id}.json"
            if not checkpoint_path.exists():
                native_plan = run / "best" / "plan.json"
                if manifest.get("variant") != candidate_id or not native_plan.exists():
                    continue
                checkpoint = {"plan": read_json(native_plan)}
            else:
                checkpoint = read_json(checkpoint_path)
            summary = read_json(summary_path)
            # summary.json is published concurrently with samples.jsonl. Wait
            # until both artifacts exist and include the whole collection.
            samples_path = summary_path.parent / "samples.jsonl"
            samples = safe_sample_metrics(samples_path)
            expected_runs = summary.get("examples", 0) * summary.get("repeats", 0)
            if expected_runs <= 0 or len(samples) != expected_runs:
                continue
            reference_id = checkpoint.get("referenceCandidateId")
            if "referenceCandidateId" not in checkpoint:
                artifact = run / "candidates" / f"{candidate_id}.json"
                if artifact.exists():
                    reference_id = read_json(artifact).get("proposal", {}).get("referenceCandidateId")
            reference_plan = None
            if isinstance(reference_id, str):
                reference_path = run / "checkpoints" / f"{reference_id}.json"
                if reference_path.exists():
                    reference_plan = read_json(reference_path).get("plan")
            found.append({"run": run, "id": candidate_id, "manifest": manifest,
                          "plan": checkpoint["plan"], "summary": summary, "samples": samples,
                          "optimizerProfile": checkpoint.get("optimizerProfile", manifest.get("optimizerProfile")),
                          "candidateOrigin": checkpoint.get("candidateOrigin"),
                          "referenceCandidateId": reference_id, "referencePlan": reference_plan,
                          "summaryVersion": summary_path.stat().st_mtime_ns})
    return found


def fonts():
    regular = Path("C:/Windows/Fonts/msyh.ttc")
    bold = Path("C:/Windows/Fonts/msyhbd.ttc")
    if not regular.exists():
        regular = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
        bold = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
    return {key: ImageFont.truetype(str(bold if heavy else regular), size)
            for key, size, heavy in [("title", 31, True), ("heading", 23, True),
                                     ("score", 24, True), ("body", 18, False),
                                     ("small", 16, False), ("node", 20, True)]}


def fit(draw, value, font, max_width):
    text = str(value)
    if draw.textlength(text, font=font) <= max_width:
        return text
    while text and draw.textlength(text + "…", font=font) > max_width:
        text = text[:-1]
    return text + "…"


def number(value):
    return f"{value:,}" if isinstance(value, (int, float)) else "未知"


def small_batch(item):
    return item["manifest"].get("protocol", {}).get("id") in {SMALL_BATCH_PROTOCOL, EXPANDED_SEARCH_PROTOCOL}


def expanded_search(item):
    return item["manifest"].get("protocol", {}).get("id") == EXPANDED_SEARCH_PROTOCOL


def frozen_expansion(item):
    return item["manifest"].get("protocol", {}).get("id") == FROZEN_EXPANSION_PROTOCOL


def split_scores(item):
    groups = item["summary"].get("groups", item["manifest"].get("groups", {}))
    def score(name):
        group = groups.get(name, {})
        value = group.get("score")
        return f"{value * 100:.3f}%" if group.get("complete") and isinstance(value, (int, float)) else "未完成"
    return score("original64"), score("additional136"), score("full200")


def candidate_report_filename(item):
    """New protocols keep distinct immutable files for every completed stage."""
    examples, repeats = item["summary"].get("examples"), item["summary"].get("repeats")
    if frozen_expansion(item):
        source = item["manifest"].get("expansion", {}).get("sourceDirectory")
        prefix = Path(source).name + "-expanded" if source else item["run"].name
        return f"{prefix}-{item['id']}-stage{item['summary'].get('stage', examples)}-n{examples}-r{repeats}.png"
    if expanded_search(item):
        return f"{item['run'].name}-{item['id']}-stage{item['summary'].get('stage', examples)}-n{examples}-r{repeats}.png"
    stage = f"-n{examples}-r{repeats}" if small_batch(item) else ""
    return f"{item['run'].name}-{item['id']}{stage}.png"


def candidate_round_label(item):
    candidate_id = item["id"]
    if candidate_id.startswith("seed-"):
        return "初始候选"
    if candidate_id.startswith("generated-") and candidate_id[10:].isdigit():
        return f"第{int(candidate_id[10:])}轮"
    return candidate_id


def confirmation(item):
    config = item["manifest"].get("confirmation")
    return isinstance(config, dict) and config.get("frozen") is True and config.get("noOptimization") is True


def usage_number(usage, *names):
    if not isinstance(usage, dict):
        return None
    for name in names:
        value = usage.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
    return None


def totals_by_run(items):
    """A manifest is cumulative: count it once even with many candidate cards."""
    manifests = {str(item["run"].resolve()): item["manifest"] for item in items}
    recorded = [manifest["newUsage"] for manifest in manifests.values() if isinstance(manifest.get("newUsage"), dict)]
    calls = [usage_number(usage, "providerAttempts", "providerAttemptCount") for usage in recorded]
    tokens = [usage_number(usage, "totalTokens") for usage in recorded]
    cached = [usage_number(manifest, "cachedRuns") if usage_number(manifest, "cachedRuns") is not None
              else usage_number(manifest.get("expansion", {}), "originalCachedRuns") for manifest in manifests.values()]
    return {
        "recordedRuns": len(recorded), "runs": len(manifests),
        "providerAttempts": sum(calls) if calls and all(value is not None for value in calls) else None,
        "totalTokens": sum(tokens) if tokens and all(value is not None for value in tokens) else None,
        "cachedRuns": sum(cached) if cached and all(value is not None for value in cached) else None,
    }


def logical_calls(summary, samples):
    value = usage_number(summary, "providerAttemptCount", "providerAttempts")
    if value is not None:
        return value
    if samples and all(isinstance(row.get("providerAttempts"), int) for row in samples):
        return sum(row["providerAttempts"] for row in samples)
    return None


def parent_diff(item):
    parent = item.get("referencePlan")
    if not parent:
        return None, None
    before = {node["id"]: node for node in parent["nodes"]}
    after = {node["id"]: node for node in item["plan"]["nodes"]}
    added = set(after) - set(before)
    changed = {key for key in set(after) & set(before) if after[key] != before[key]}
    deleted = set(before) - set(after)
    return before, f"较父 {item['referenceCandidateId']}：新增 {len(added)} / 改 {len(changed)} / 删 {len(deleted)}"


def arrow(draw, start, end, fill=MUTED, width=2):
    draw.line([start, end], fill=fill, width=width)
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    points = [end]
    for offset in (-0.55, 0.55):
        points.append((end[0] - 8 * math.cos(angle + offset),
                       end[1] - 8 * math.sin(angle + offset)))
    draw.polygon(points, fill=fill)


def node_label(node):
    kind = node["type"]
    config = node.get("config", {})
    names = {"CONTEXT.LOAD": "载入题目 / 上游结果", "INFER.REASONING.SAMPLE": "模型作答",
             "INFER.REASONING.TRAJECTORY": "多路径推理", "INFER.REASONING.REFLECT": "检查 / 修订",
             "INFER.REASONING.DELIBERATE": "选择 / 整合候选", "INTERACTION.ACT.TOOL": "调用工具",
             "INTERACTION.OBSERVE": "接收工具结果"}
    short = kind.removeprefix("INFER.REASONING.")
    detail = config.get("mode") or config.get("strategy")
    return names.get(kind, kind), f"{short}" + (f" [{detail}]" if detail else "")


def graph_height(graph):
    return 42 + len(graph["nodeIds"]) * 103


def render_detailed(items, output):
    if not items:
        return False
    f = fonts()
    card_width, gap, margin = 560, 22, 30
    card_y, graph_offset, footer_height = 175, 318, 210
    rows = [sum(graph_height(g) + 25 for g in item["plan"]["graphs"]) for item in items]
    body_height = max(rows)
    height = max(950, card_y + graph_offset + body_height + footer_height)
    width = margin * 2 + len(items) * card_width + (len(items) - 1) * gap
    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)
    datasets = sorted({str(x["manifest"].get("dataset", "unknown")).upper() for x in items})
    exploratory = any(small_batch(item) and not confirmation(item) for item in items)
    confirmed_only = all(confirmation(item) for item in items)
    expansion_only = all(frozen_expansion(item) for item in items)
    contains_expansion = any(frozen_expansion(item) for item in items)
    contains_expanded_search = any(expanded_search(item) for item in items)
    contains_confirmation = any(confirmation(item) for item in items)
    batches = {(item["summary"].get("examples"), item["summary"].get("repeats")) for item in items}
    if expansion_only:
        title = "冻结候选·原200题扩展验证"
    elif contains_expansion:
        title = "原200题扩展与分阶段搜索"
    elif contains_expanded_search:
        title = "原200题自动搜索·分阶段实际流程"
    elif confirmed_only and len(batches) == 1:
        examples, repeat_count = next(iter(batches))
        title = f"冻结候选·{examples}题×{repeat_count}次确认"
    elif contains_confirmation:
        title = "冻结候选确认与搜索记录"
    else:
        title = "小批量自动搜索 · 实际流程与得分" if exploratory else "实际验证流程与得分"
    draw.text((margin, 20), f"{' / '.join(datasets)} · {title}", font=f["title"], fill=INK)
    if expansion_only:
        notice = "原64题缓存复用，新增136题；完整200题各1次，尚非5次重复验证。"
        draw.text((margin, 65), fit(draw, notice, f["body"], width - margin * 2), font=f["body"], fill=CAUTION)
    elif contains_expanded_search or contains_expansion:
        notice = "搜索阶段16→32→64→128→200；仅完整200题阶段可作全量比较，重复次数按各卡显示。"
        draw.text((margin, 65), fit(draw, notice, f["body"], width - margin * 2), font=f["body"], fill=CAUTION)
    elif confirmed_only and len(batches) == 1:
        examples, repeat_count = next(iter(batches))
        runs = examples * repeat_count
        notice = f"固定 {examples} 题重复 {repeat_count} 次，共 {runs} 题次；并非 {runs} 道独立题。"
        draw.text((margin, 65), fit(draw, notice, f["body"], width - margin * 2), font=f["body"], fill=CAUTION)
    elif contains_confirmation:
        notice = "确认卡重复固定原题；搜索卡不同样本阶段不可直接排名。"
        draw.text((margin, 65), fit(draw, notice, f["body"], width - margin * 2), font=f["body"], fill=CAUTION)
    elif exploratory or len(batches) > 1:
        notice = "不同题数 / 样本阶段不可直接排名；单次 F1 不是重复验证均值。"
        draw.text((margin, 65), fit(draw, notice, f["body"], width - margin * 2), font=f["body"], fill=CAUTION)
    else:
        draw.text((margin, 65), "题数与重复次数按各卡实际产物显示。", font=f["body"], fill=MUTED)
    totals = totals_by_run(items)
    if totals["recordedRuns"]:
        if expansion_only:
            calls_label = f"扩展总新增：模型请求 {number(totals['providerAttempts'])}（冻结流程，无优化调用）"
        else:
            calls_label = f"确认总新增：模型请求 {number(totals['providerAttempts'])}（冻结流程，无优化调用）" if confirmed_only else f"运行总新增：模型请求 {number(totals['providerAttempts'])}（含优化器、修复、新评估）"
        draw.text((margin, 94), fit(draw, calls_label, f["small"], width - margin * 2), font=f["small"], fill=INK)
        draw.text((margin, 120), fit(draw, f"运行总新增：已记录 Token {number(totals['totalTokens'])}；缓存复用 {number(totals['cachedRuns'])} 题次；总账覆盖 {totals['recordedRuns']}/{totals['runs']} 个运行。", f["small"], width - margin * 2), font=f["small"], fill=INK)
    else:
        draw.text((margin, 94), "旧产物未记录含优化器的总账；不将候选验证消耗冒充运行总消耗。", font=f["small"], fill=MUTED)
    draw.text((margin, 146), "青框：相对实际父候选新增 / 修改；实线只画已声明依赖与 next 转移。", font=f["small"], fill=MUTED)
    for index, item in enumerate(items):
        x, y = margin + index * (card_width + gap), card_y
        plan, summary, manifest, samples = (item[key] for key in ("plan", "summary", "manifest", "samples"))
        draw.rounded_rectangle((x, y, x + card_width, height - 22), 11, fill="white", outline=BORDER)
        is_expansion = frozen_expansion(item)
        profile = item.get("optimizerProfile", manifest.get("optimizerProfile")) or ("冻结原执行器" if is_expansion else "手工设计" if manifest.get("variant") else "未标注")
        representation = manifest.get("representation")
        cached_origin = item.get("candidateOrigin") == "llm-generated-cache"
        is_confirmation = confirmation(item)
        label = f"{item['id']}" + (f" · {representation}" if representation else f" · {profile}")
        if is_expansion:
            label += " · 冻结扩展"
        elif is_confirmation:
            label += " · 冻结确认"
        elif cached_origin:
            label += " · 历史缓存"
        draw.text((x + 18, y + 16), fit(draw, label, f["heading"], card_width - 36), font=f["heading"], fill=INK)
        score = summary.get("score")
        valid = summary.get("valid") is True and summary.get("failedRuns", 0) == 0
        metric = "F1" if manifest.get("dataset") == "drop" else "得分"
        repeat_count = summary.get("repeats")
        score_kind = "单次" if repeat_count == 1 else "重复平均"
        score_label = f"{score_kind} {metric} {score * 100:.3f}%" if valid and isinstance(score, (int, float)) else "评测无效，分数不用于比较"
        draw.text((x + 18, y + 54), score_label, font=f["score"], fill=TEAL if valid else "#b84b42")
        stage = "冻结流程扩展" if is_expansion else "冻结候选确认" if is_confirmation else f"阶段{summary.get('stage', summary.get('examples', '?'))}/200" if expanded_search(item) else "小批量探索" if small_batch(item) else "验证"
        draw.text((x + 18, y + 95), f"{summary.get('examples', '?')} 题 × {repeat_count or '?'} 次 · {stage}", font=f["body"], fill=CAUTION if small_batch(item) and not is_confirmation else INK)
        repeats = summary.get("repeatScores")
        if not valid:
            draw.text((x + 18, y + 123), "包含工程失败或缺失；占位分数不展示", font=f["body"], fill=CAUTION)
        elif is_expansion:
            old_score, extra_score, full_score = split_scores(item)
            draw.text((x + 18, y + 123), fit(draw, f"原64题 {old_score} · 新136题 {extra_score}", f["body"], card_width - 36), font=f["body"], fill=INK)
            draw.text((x + 18, y + 149), f"全200题 {full_score}；复用64 / 新增136题", font=f["small"], fill=CAUTION)
        elif repeats and len(repeats) > 1:
            draw.text((x + 18, y + 122), "各次：" + " / ".join(f"{v * 100:.3f}" for v in repeats[:3]), font=f["body"], fill=MUTED)
            if len(repeats) > 3:
                draw.text((x + 18, y + 148), "　　　" + " / ".join(f"{v * 100:.3f}" for v in repeats[3:]), font=f["body"], fill=MUTED)
        elif expanded_search(item):
            draw.text((x + 18, y + 123), "阶段：16 → 32 → 64 → 128 → 200", font=f["body"], fill=CAUTION)
            completion_note = "已完成原200题单次；尚非5次重复" if summary.get("examples") == 200 else "当前仅阶段样本，不能称为全200题成绩"
            draw.text((x + 18, y + 149), completion_note, font=f["small"], fill=CAUTION)
        elif exploratory and not is_confirmation:
            draw.text((x + 18, y + 123), "不同题数 / 样本阶段不可直接排名", font=f["body"], fill=CAUTION)
        if is_confirmation and repeat_count and (not repeats or len(repeats) <= 3):
            examples = summary.get("examples", 0)
            runs = examples * repeat_count
            draw.text((x + 18, y + 148), f"固定 {examples} 题；{runs} 题次不等于 {runs} 道独立题", font=f["small"], fill=CAUTION)
        calls = logical_calls(summary, samples)
        draw.text((x + 18, y + 180), f"验证逻辑请求 {number(calls)}（含缓存）；节点 {len(plan['nodes'])}", font=f["body"], fill=MUTED)
        new_usage = summary.get("newUsage")
        new_calls = usage_number(new_usage, "providerAttempts", "providerAttemptCount")
        draw.text((x + 18, y + 207), f"本候选新评估请求 {number(new_calls)}", font=f["body"], fill=INK)
        draw.text((x + 18, y + 234), fit(draw, f"{manifest.get('model', '未知模型')} · {profile}", f["small"], card_width - 36), font=f["small"], fill=MUTED)
        parent, diff_label = parent_diff(item)
        if diff_label is None:
            parent_id = item.get("referenceCandidateId")
            diff_label = f"父候选 {parent_id} 不可用；未标注差异" if parent_id else "无父候选；未标注结构差异"
        draw.text((x + 18, y + 261), fit(draw, diff_label, f["small"], card_width - 36), font=f["small"], fill=MUTED)
        transitions = plan.get("loop", {}).get("transitions", {})
        if plan.get("loop", {}).get("control") == "generated-code":
            loop_note = "Loop：生成代码控制，图间连线未推断"
        else:
            controls = sorted({transition.get("kind", "未知") for transition in transitions.values()} - {"next", "end"})
            loop_note = "Loop：" + (" / ".join(controls) if controls else "按已声明的转移显示")
        draw.text((x + 18, y + 288), fit(draw, loop_note, f["small"], card_width - 36), font=f["small"], fill=MUTED)
        nodes = {node["id"]: node for node in plan["nodes"]}
        gy, positions = y + graph_offset, {}
        group_bounds = {}
        for group in plan["graphs"]:
            gh = graph_height(group)
            draw.rounded_rectangle((x + 16, gy, x + card_width - 16, gy + gh), 9, fill=GROUP, outline=BORDER)
            draw.text((x + 26, gy + 8), f"{group['id']} Graph", font=f["body"], fill=MUTED)
            for local_index, node_id in enumerate(group["nodeIds"]):
                node = nodes[node_id]
                ny = gy + 36 + local_index * 103
                changed = parent is not None and parent.get(node_id) != node
                draw.rounded_rectangle((x + 28, ny, x + card_width - 43, ny + 78), 7,
                                       fill="#effaf7" if changed else "white", outline=TEAL if changed else BORDER,
                                       width=3 if changed else 1)
                label, operation = node_label(node)
                draw.text((x + 39, ny + 7), fit(draw, label, f["node"], card_width - 90), font=f["node"], fill=INK)
                draw.text((x + 39, ny + 35), fit(draw, operation, f["small"], card_width - 90), font=f["small"], fill=MUTED)
                draw.text((x + 39, ny + 57), fit(draw, node_id, f["small"], card_width - 90), font=f["small"], fill=MUTED)
                positions[node_id] = (x + 28, ny, x + card_width - 43, ny + 78)
            group_bounds[group["id"]] = (gy, gy + gh)
            gy += gh + 25
        # Never connect parallel siblings by vertical position alone.
        for node in plan["nodes"]:
            target = positions.get(node["id"])
            if not target:
                continue
            for dependency in node.get("dependencies", []):
                source = positions.get(dependency)
                if not source:
                    continue
                if target[1] - source[3] < 45:
                    arrow(draw, ((source[0] + source[2]) / 2, source[3]), ((target[0] + target[2]) / 2, target[1]))
                else:
                    lane = x + card_width - 29
                    draw.line([(source[2], (source[1] + source[3]) / 2), (lane, (source[1] + source[3]) / 2), (lane, (target[1] + target[3]) / 2)], fill=MUTED, width=2)
                    arrow(draw, (lane, (target[1] + target[3]) / 2), (target[2], (target[1] + target[3]) / 2))
        for graph_id, transition in transitions.items():
            target_id = transition.get("graphId") if transition.get("kind") == "next" else None
            if graph_id in group_bounds and target_id in group_bounds:
                arrow(draw, (x + card_width / 2, group_bounds[graph_id][1]), (x + card_width / 2, group_bounds[target_id][0]))
        foot = height - 180
        if plan.get("loop", {}).get("control") == "generated-code":
            output_label = f"输出：Loop 返回 answer；声明末节点：{plan.get('outputNodeId', '未知')}"
        else:
            output_label = f"输出：{plan.get('outputNodeId', '未知')}；有效 {summary.get('validRuns', '未知')} 题次"
        draw.text((x + 18, foot), fit(draw, output_label, f["body"], card_width - 36), font=f["body"], fill=MUTED)
        token_complete = summary.get("tokenUsageStatus") == "complete"
        draw.text((x + 18, foot + 30), f"验证逻辑 Token {'总计' if token_complete else '下界'} {number(summary.get('totalTokens'))}（含缓存）", font=f["body"], fill=INK)
        draw.text((x + 18, foot + 58), f"本候选新评估已记录 Token {number(usage_number(new_usage, 'totalTokens'))}", font=f["body"], fill=INK)
        latencies = [row["latencyMs"] for row in samples if isinstance(row.get("latencyMs"), (int, float))]
        latency = f"{sum(latencies) / len(latencies) / 1000:.3f} 秒" if len(latencies) == len(samples) else "未知"
        draw.text((x + 18, foot + 86), f"逻辑平均单题耗时 {latency}", font=f["body"], fill=MUTED)
        reused = summary.get("reusedCases", summary.get("reusedOriginalCases"))
        if is_expansion:
            reused = reused if isinstance(reused, int) else manifest.get("expansion", {}).get("originalCachedRuns", 64)
            reuse_text = f"复用原{number(reused)}题；新增{number(summary.get('examples', 200) - reused)}题（单次）"
        elif is_confirmation and isinstance(reused, int):
            total_runs = summary.get("examples", 0) * (repeat_count or 0)
            reuse_label = "复用首轮" if reused == summary.get("examples") else "缓存复用"
            reuse_text = f"{reuse_label} {number(reused)} 题次；新增 {number(total_runs - reused)} 题次"
        elif reused is None and not small_batch(item):
            reuse_text = "缓存复用题次：旧产物未单独记录"
        else:
            reuse_text = f"缓存复用 {number(reused)} 题次；新评估不重复计缓存"
        draw.text((x + 18, foot + 114), fit(draw, reuse_text, f["small"], card_width - 36), font=f["small"], fill=MUTED)
        if is_expansion:
            accounting_note = "冻结原候选扩展，无优化调用；原64题不重复计费。"
        elif is_confirmation:
            accounting_note = "冻结候选，无调优；新增仅计本次补跑。"
        else:
            accounting_note = "历史模型生成候选·缓存重算；新评估不含优化器。" if cached_origin else "候选新评估不含优化器；顶部为含优化器总账。"
        draw.text((x + 18, foot + 140), accounting_note, font=f["small"], fill=MUTED)
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)
    return True


def render(items, output):
    """Compact default: scores and real graph structure; evidence stays in JSON."""
    if not items:
        return False
    f = fonts()
    card_width, gap, margin = 520, 20, 24
    card_y, graph_y, node_step = 103, 263, 77
    graph_size = lambda group: 34 + len(group["nodeIds"]) * node_step
    body_heights = [sum(graph_size(group) + 18 for group in item["plan"]["graphs"]) for item in items]
    width = margin * 2 + len(items) * card_width + (len(items) - 1) * gap
    height = max(780, graph_y + max(body_heights) + 118)
    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)
    datasets = sorted({str(item["manifest"].get("dataset", "")).upper() for item in items})
    draw.text((margin, 20), f"{' / '.join(datasets)} 工作流验证", font=f["title"], fill=INK)
    models = " / ".join(sorted({str(item["manifest"].get("model", "")) for item in items}))
    batches = {(item["summary"].get("examples"), item["summary"].get("repeats")) for item in items}
    if len(batches) == 1:
        examples, repeats = next(iter(batches))
        subtitle = f"{models} · {examples}题 × {repeats}次"
    else:
        subtitle = f"{models} · 分阶段验证"
    draw.text((margin, 64), fit(draw, subtitle, f["body"], width - 2 * margin), font=f["body"], fill=MUTED)
    for index, item in enumerate(items):
        x = margin + index * (card_width + gap)
        plan, summary, manifest = item["plan"], item["summary"], item["manifest"]
        draw.rounded_rectangle((x, card_y, x + card_width, height - 22), 12, fill="white", outline=BORDER)
        representation = manifest.get("representation")
        heading = "方案 A · 完整模块" if representation == "A" else "方案 B · 定义执行" if representation == "B" else f"候选 {item['id']}"
        same_representation = sum(other["manifest"].get("representation") == representation for other in items)
        if representation in {"A", "B"} and (same_representation > 1 or expanded_search(item)):
            kind = "完整模块" if representation == "A" else "定义执行"
            heading = f"方案 {representation} · {candidate_round_label(item)} · {kind}"
        draw.text((x + 20, card_y + 16), fit(draw, heading, f["heading"], card_width - 40), font=f["heading"], fill=INK)
        valid = summary.get("valid") is True and summary.get("failedRuns", 0) == 0
        score = summary.get("score")
        score_label = "平均 F1" if summary.get("repeats", 1) > 1 else "F1"
        score_text = f"{score_label} {score * 100:.3f}%" if valid and isinstance(score, (int, float)) else "未完成"
        draw.text((x + 20, card_y + 56), score_text, font=f["title"], fill=TEAL if valid else CAUTION)
        examples, repeats = summary.get("examples", "?"), summary.get("repeats", "?")
        stage_text = f"{examples}题 × {repeats}次"
        if expanded_search(item):
            stage_text += f" · 阶段 {summary.get('stage', examples)}/200"
        elif small_batch(item) and not confirmation(item):
            stage_text += f" · 阶段 {summary.get('stage', examples)}/64"
        draw.text((x + 20, card_y + 101), stage_text, font=f["body"], fill=MUTED)
        if frozen_expansion(item):
            old_score, extra_score, _ = split_scores(item)
            draw.text((x + 20, card_y + 129), f"原64题 {old_score}  ·  新136题 {extra_score}", font=f["small"], fill=MUTED)
        elif summary.get("repeats", 1) > 1 and summary.get("repeatScores"):
            values = " / ".join(f"{value * 100:.3f}" for value in summary["repeatScores"][:5])
            draw.text((x + 20, card_y + 129), fit(draw, f"各次 {values}%", f["small"], card_width - 40), font=f["small"], fill=MUTED)
        elif representation == "A" and item.get("referencePlan"):
            before = item["referencePlan"].get("nodes", [])
            structure = lambda values: [{key: value for key, value in node.items() if key != "config"} for node in values]
            if structure(before) == structure(plan["nodes"]) and before != plan["nodes"]:
                reference = candidate_round_label({"id": item["referenceCandidateId"]})
                label = f"较{reference}：提示词/代码有变，节点结构相同"
                draw.text((x + 20, card_y + 129), fit(draw, label, f["small"], card_width - 40), font=f["small"], fill=MUTED)
        nodes = {node["id"]: node for node in plan["nodes"]}
        positions, bounds = {}, {}
        gy = graph_y
        for group in plan["graphs"]:
            gh = graph_size(group)
            draw.rounded_rectangle((x + 16, gy, x + card_width - 16, gy + gh), 9, fill=GROUP, outline=BORDER)
            draw.text((x + 27, gy + 7), fit(draw, f"{group['id']} Graph", f["small"], card_width - 70), font=f["small"], fill=MUTED)
            for local_index, node_id in enumerate(group["nodeIds"]):
                node = nodes[node_id]
                ny = gy + 31 + local_index * node_step
                rect = (x + 30, ny, x + card_width - 47, ny + 62)
                draw.rounded_rectangle(rect, 7, fill="white", outline=BORDER)
                operation = node["type"].removeprefix("INFER.REASONING.")
                draw.text((rect[0] + 12, ny + 7), fit(draw, operation, f["node"], card_width - 105), font=f["node"], fill=INK)
                draw.text((rect[0] + 12, ny + 35), fit(draw, node_id, f["small"], card_width - 105), font=f["small"], fill=MUTED)
                positions[node_id] = rect
            bounds[group["id"]] = (gy, gy + gh)
            gy += gh + 18
        # Vertical placement is not an edge. Draw only real local dependencies.
        for node in plan["nodes"]:
            target = positions.get(node["id"])
            if not target:
                continue
            for dependency in node.get("dependencies", []):
                source = positions.get(dependency)
                if not source:
                    continue
                if target[1] - source[3] < 36:
                    arrow(draw, ((source[0] + source[2]) / 2, source[3]), ((target[0] + target[2]) / 2, target[1]))
                else:
                    lane = x + card_width - 31
                    draw.line([(source[2], (source[1] + source[3]) / 2), (lane, (source[1] + source[3]) / 2), (lane, (target[1] + target[3]) / 2)], fill=MUTED, width=2)
                    arrow(draw, (lane, (target[1] + target[3]) / 2), (target[2], (target[1] + target[3]) / 2))
        # Generated A control code is not reverse-engineered into guessed edges.
        if plan.get("loop", {}).get("control") != "generated-code":
            for graph_id, transition in plan.get("loop", {}).get("transitions", {}).items():
                target_id = transition.get("graphId") if transition.get("kind") == "next" else None
                if graph_id in bounds and target_id in bounds:
                    arrow(draw, (x + card_width / 2, bounds[graph_id][1]), (x + card_width / 2, bounds[target_id][0]))
        usage = summary.get("newUsage")
        new_calls = usage_number(usage, "providerAttempts", "providerAttemptCount")
        new_tokens = usage_number(usage, "totalTokens")
        footer = f"新增调用 {number(new_calls)} · Token {number(new_tokens)}"
        draw.text((x + 20, height - 93), fit(draw, footer, f["body"], card_width - 40), font=f["body"], fill=INK)
        output_label = "answer（Loop 返回）" if plan.get("loop", {}).get("control") == "generated-code" else plan.get("outputNodeId", "answer")
        draw.text((x + 20, height - 63), fit(draw, f"输出：{output_label}", f["small"], card_width - 40), font=f["small"], fill=MUTED)
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dirs", nargs="+", type=Path, help="Saved run directory/directories, in display order")
    parser.add_argument("--output", type=Path, default=Path("workflow-report.png"))
    parser.add_argument("--watch", type=float, default=0, metavar="SECONDS", help="Poll completed validation artifacts")
    parser.add_argument("--detailed", action="store_true", help="Render the former full evidence/accounting layout")
    args = parser.parse_args()
    known = {}
    known_totals = None
    while True:
        items = candidates(args.run_dirs)
        signatures = {(str(x["run"]), x["id"]): (x["summaryVersion"], x["summary"].get("examples"), x["summary"].get("repeats"), x.get("optimizerProfile"), x.get("candidateOrigin")) for x in items}
        current_totals = totals_by_run(items)
        if (signatures != known or current_totals != known_totals) and items:
            renderer = render_detailed if args.detailed else render
            renderer(items, args.output)
            for item in items:
                key = (str(item["run"]), item["id"])
                if signatures[key] != known.get(key):
                    single_path = args.output.parent / candidate_report_filename(item)
                    parent = next((candidate for candidate in items if candidate["run"] == item["run"] and candidate["id"] == item.get("referenceCandidateId")), None)
                    renderer([parent, item] if parent is not None else [item], single_path)
                    print(json.dumps({"phase": "workflow-report", "candidateId": item["id"],
                                      "examples": item["summary"].get("examples"), "repeats": item["summary"].get("repeats"),
                                      "path": str(single_path.resolve()), "overview": str(args.output.resolve())}), flush=True)
            known = signatures
            known_totals = current_totals
        if not args.watch:
            if not items:
                print(json.dumps({"phase": "workflow-report", "status": "waiting-for-complete-validation"}))
            return
        time.sleep(max(1, args.watch))


if __name__ == "__main__":
    main()
