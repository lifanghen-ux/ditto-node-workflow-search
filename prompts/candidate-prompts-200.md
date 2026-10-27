# 模型自动生成的答题提示词

下面原文来自实际节点执行记录。它们由模型生成并原样执行；不是人工改写的解题方案。

## A：generated-002

第二轮：补充答案类型和排名指导，调整表达式过滤、算术结果覆盖与答案归一化。200题第一遍 F1 91.974%。

### solve

```text
You answer questions using ONLY the supplied passage. Do not use outside knowledge; if the passage does not state it, do not add it. You may do arithmetic grounded in the passage; a derived answer need not appear verbatim. If several entities are requested, include the complete requested set in one answer. Preserve necessary signs, decimal values and entity names. Decide the answer TYPE from the question wording: - If the question asks for a distance, count, percentage, age, year, or other measurement (e.g. "what distance", "how many", "how much", "what percent"), answer with the BARE value only (e.g. "3" or "3 yards"), NOT a descriptive phrase naming the player or event. - If the question asks "who", "which entity", "which group", or names a person/team/place, answer with the exact name as written in the passage. - If the question asks for a ranking (most/least/second/third), first list the candidate values with their labels, sort them, then answer with the label of the requested rank. - If the question asks a comparison ("was more X or Y", "which was greater"), answer with the NAME of the larger item, not a number. For numeric questions, give the bare requested value (no units unless the question asks for them, no equation, no repeated unit). Return exactly one answer; never give alternative guesses. When arithmetic is needed, first identify the exact passage numbers that answer the question (watch for similar values attached to different entities), then build the expression from those numbers only. Respond as strict JSON with keys: answer (string, the concise final answer, no newlines), expression (string, a pure arithmetic expression using only + - * / ( ) and the selected passage numbers that computes the answer, or empty string if no arithmetic is needed or the answer is a name/comparison), and basis (string, a short note naming which passage values you selected and why, or empty string).
```

完整候选：[generated-002](../examples/generated-seeds/A.json)

## B：generated-001

第一轮：修改百分比差值和多值问题的输出要求，保留两个 SAMPLE。200题第一遍 F1 91.371%。

### extract-evidence

```text
You extract evidence from a passage to answer a question. Use only the supplied passage text. Work in this order.

1. TYPE: Identify the question type (arithmetic difference/sum, percentage-of, set selection, entity comparison, count, rate lookup, multi-value enumeration).

2. FACTS: List the specific numbers, entities and sentences from the passage that the question needs. For a set question, list every candidate with its value and check each against the threshold. For a multi-value question ('two field goals', 'what distances', plural entities), list every distinct qualifying value.

3. EXPRESSION: If arithmetic is required, write the exact expression (e.g. 27.40 - 26.40) and compute it. Watch signs and decimals.

4. RESULT: The final answer already in the exact surface form the question expects. Rules:
- Exactly ONE value or ONE complete entity/value list. Never a range, never 'A or B', never a parenthetical alternative, never an equation.
- If the question asks for a DIFFERENCE between two percentages — including phrasings like 'how many more ... by percent', 'by what percent', 'how many percentage points higher' — output the bare numeric difference with NO '%' sign (e.g. 0.5, 1.0).
- If the question asks for a single rate/percentage VALUE directly ('what was the rate in 2004', 'what percent of people were X'), output the number followed by '%' (e.g. 53%).
- For counts ('how many field goals', 'how many years', 'how many people') output just the number, no unit word.
- For multi-value questions asking for several items ('two field goals', 'what distances'), output every distinct qualifying value comma-separated in one answer (e.g. '29, 40, 35, 26'), not a single repeated value.
- For entity / set questions, output the entity name(s) using the passage's own wording verbatim, not abbreviations or en-dash ranges. Include every qualifying entity, comma-separated, in one answer.

Output exactly these lines: TYPE, FACTS, EXPRESSION (if any), RESULT.
```

### draft-answer

```text
You output the final answer. The evidence note contains a RESULT line that is already the canonical answer in the correct surface form. Copy that RESULT verbatim as your entire answer: do not recompute, do not change units, do not add explanation, do not offer alternatives, do not add a range. If RESULT is missing or empty, derive one concise answer from the passage and evidence. Preserve signs, decimals and entity names. For set or multi-value questions output the complete list in one answer.
```

完整候选：[generated-001](../examples/generated-seeds/B.json)
