"""Stream provider calls and return complete OpenAI JSON to Ditto's invoke parser."""
import asyncio
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx
from openai import AsyncOpenAI, APIStatusError, APIConnectionError, APITimeoutError


def log(record):
    target = os.environ.get("DITTO_PROVIDER_LOG")
    if target:
        path = Path(target)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as output:
            output.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), **record}) + "\n")


class StreamIncompleteError(Exception):
    pass


class ProviderCooldown:
    """One bridge-wide rate-limit deadline shared by retries and new requests."""
    def __init__(self, clock=time.monotonic, sleep=asyncio.sleep, wall_clock=time.time):
        self.clock = clock
        self.sleep = sleep
        self.wall_clock = wall_clock
        self.until = 0

    def defer(self, seconds):
        self.until = max(self.until, self.clock() + seconds)

    async def wait(self, deadline):
        while self.until > self.clock():
            delay = self.until - self.clock()
            if delay >= deadline - self.clock():
                raise TimeoutError("Provider cooldown exceeds request deadline")
            await self.sleep(delay)


def provider_error_details(error):
    """Only service error fields; never serialize headers, auth or request bodies."""
    body = getattr(error, "body", None)
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        body = body["error"]
    if not isinstance(body, dict):
        return {}
    return {key: str(body[key])[:1000] for key in ("code", "message") if body.get(key) is not None}


def rate_limit_delay(error, attempt, wall_clock=time.time):
    value = error.response.headers.get("retry-after") if isinstance(error, APIStatusError) else None
    seconds = None
    if value is not None:
        try:
            seconds = float(value)
        except ValueError:
            try:
                seconds = parsedate_to_datetime(value).timestamp() - wall_clock()
            except (ValueError, TypeError, OverflowError):
                pass
    if seconds is None or not (seconds >= 0 and seconds < float("inf")):
        return 10 * attempt, None
    # Bound hostile/accidental headers, and never retry immediately on Retry-After: 0.
    return min(300, max(1, seconds)), seconds


def request_body(body):
    """The experiment protocol is fixed across baseline, nodes and optimizer."""
    result = {key: value for key, value in body.items()
              if key not in {"top_p", "reasoning_effort", "max_completion_tokens", "thinking"}}
    extra = {key: value for key, value in result.pop("extra_body", {}).items()
             if key not in {"top_p", "reasoning_effort", "max_tokens", "max_completion_tokens",
                            "temperature", "n", "response_format", "stream", "stream_options"}}
    result.update(temperature=0, max_tokens=393216, n=1,
                  response_format={"type": "text"}, stream=True,
                  stream_options={"include_usage": True})
    result["extra_body"] = {**extra, "thinking": {"type": "disabled"}}
    return result


async def aggregate_stream(stream, raw, progress=None):
    """Preserve content, fragmented/interleaved tool calls, finish reason and usage."""
    calls = {}
    message = {"role": "assistant", "content": ""}
    choice = {"index": 0, "message": message}
    raw["choices"] = [choice]
    async for chunk in stream:
        if progress is not None:
            progress["chunks"] += 1
            progress["lastChunkAt"] = time.monotonic()
        data = chunk.model_dump(exclude_none=True)
        for key in ("id", "model", "created", "system_fingerprint"):
            if key in data:
                raw[key] = data[key]
        if "usage" in data:
            raw["usage"] = data["usage"]
        for part in data.get("choices", []):
            if part.get("index", 0) != 0:
                raise StreamIncompleteError("Unexpected candidate index")
            delta = part.get("delta", {})
            for key in ("content", "reasoning_content"):
                if delta.get(key) is not None:
                    message[key] = message.get(key, "") + delta[key]
            for fragment in delta.get("tool_calls", []):
                call = calls.setdefault(fragment["index"], {"id": "", "type": "function",
                                        "function": {"name": "", "arguments": ""}})
                if fragment.get("id"):
                    call["id"] += fragment["id"]
                if fragment.get("type"):
                    call["type"] = fragment["type"]
                for key in ("name", "arguments"):
                    call["function"][key] += fragment.get("function", {}).get(key, "") or ""
                message["tool_calls"] = [calls[index] for index in sorted(calls)]
            if part.get("finish_reason") is not None:
                choice["finish_reason"] = part["finish_reason"]
        if progress is not None:
            progress["contentChars"] = len(message["content"])
    if calls:
        message["tool_calls"] = [calls[index] for index in sorted(calls)]
    if "finish_reason" not in choice:
        raise StreamIncompleteError("Stream ended without a finish reason")
    return raw


def usage_counts(usage):
    usage = usage or {}
    valid = lambda value: isinstance(value, int) and not isinstance(value, bool) and value >= 0
    input_tokens = usage.get("prompt_tokens")
    output_tokens = usage.get("completion_tokens")
    known = valid(input_tokens) and valid(output_tokens)
    total_tokens = usage.get("total_tokens")
    input_tokens = input_tokens if valid(input_tokens) else 0
    output_tokens = output_tokens if valid(output_tokens) else 0
    return known, input_tokens, output_tokens, total_tokens if valid(total_tokens) else input_tokens + output_tokens


async def report_progress(request_id, attempt, started, progress, emit, interval=10):
    """Log waiting/stream activity without exposing per-chunk content."""
    while True:
        await asyncio.sleep(interval)
        now = time.monotonic()
        emit({"phase": "stream-progress", "id": request_id, "attempt": attempt,
              "elapsedMs": round((now - started) * 1000), "chunks": progress["chunks"],
              "contentChars": progress["contentChars"],
              "lastChunkAgoMs": None if progress["lastChunkAt"] is None else round((now - progress["lastChunkAt"]) * 1000)})


async def complete(client, request, timeout_ms, emit=log, attempts=3, cooldown=None):
    cooldown = cooldown or ProviderCooldown()
    attempts = max(1, min(3, attempts))
    body = request_body(request["body"])
    digest = hashlib.sha256(json.dumps(body.get("messages"), ensure_ascii=False).encode()).hexdigest()
    deadline = cooldown.clock() + min(timeout_ms, 600000) / 1000
    diagnostics = {"requestId": request["id"], "attempts": 0, "failedAttempts": 0,
                   "unknownUsageAttempts": 0, "usageKnown": True,
                   "inputTokens": 0, "outputTokens": 0, "totalTokens": 0}

    def account(raw, failed):
        known, input_tokens, output_tokens, total_tokens = usage_counts(raw.get("usage"))
        diagnostics["attempts"] += 1
        diagnostics["failedAttempts"] += int(failed)
        diagnostics["unknownUsageAttempts"] += int(not known)
        diagnostics["usageKnown"] = diagnostics["usageKnown"] and known
        diagnostics["inputTokens"] += input_tokens
        diagnostics["outputTokens"] += output_tokens
        diagnostics["totalTokens"] += total_tokens

    for attempt in range(1, attempts + 1):
        try:
            await cooldown.wait(deadline)
            if cooldown.clock() >= deadline:
                raise TimeoutError("Provider request deadline exceeded")
        except (TimeoutError, asyncio.CancelledError) as error:
            status = 499 if isinstance(error, asyncio.CancelledError) else 504
            emit({"phase": "cooldown-ended", "id": request["id"], "status": status,
                  "errorType": type(error).__name__, "diagnostics": dict(diagnostics)})
            return {"id": request["id"], "status": status, "diagnostics": diagnostics,
                    "body": {"error": {"type": type(error).__name__, "attempts": diagnostics["attempts"]}}}
        raw = {}
        started = time.monotonic()
        emit({"phase": "request", "id": request["id"], "attempt": attempt,
              "promptHash": digest, "model": body["model"],
              "parameters": {key: body[key] for key in ("temperature", "max_tokens", "n", "response_format", "stream")},
              "thinking": body["extra_body"]["thinking"]})
        try:
            remaining = deadline - cooldown.clock()
            if remaining <= 0:
                raise TimeoutError("Provider request deadline exceeded")
            progress = {"chunks": 0, "contentChars": 0, "lastChunkAt": None}
            heartbeat = asyncio.create_task(report_progress(request["id"], attempt, started, progress, emit))
            try:
                async with asyncio.timeout(remaining):
                    stream = await client.chat.completions.create(**body,
                        timeout=httpx.Timeout(remaining, connect=min(5, remaining)))
                    async with stream:
                        await aggregate_stream(stream, raw, progress)
            finally:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
            account(raw, False)
            emit({"phase": "response", "id": request["id"], "attempt": attempt,
                  "elapsedMs": round((time.monotonic() - started) * 1000),
                  "model": raw.get("model"), "usage": raw.get("usage"),
                  "usageStatus": "known" if usage_counts(raw.get("usage"))[0] else "unknown",
                  "diagnostics": diagnostics,
                  "finishReason": raw["choices"][0]["finish_reason"],
                  "response": raw,
                  "contentChars": len(raw["choices"][0]["message"]["content"])})
            return {"id": request["id"], "status": 200, "body": raw, "diagnostics": diagnostics}
        except (Exception, asyncio.CancelledError) as error:
            status = error.status_code if isinstance(error, APIStatusError) else (
                504 if isinstance(error, (TimeoutError, APITimeoutError)) else
                499 if isinstance(error, asyncio.CancelledError) else 502)
            transient = isinstance(error, (APIConnectionError, APITimeoutError, StreamIncompleteError)) or status in (408, 409, 429) or status >= 500
            delay, retry_after = rate_limit_delay(error, attempt, cooldown.wall_clock) if status == 429 else (0.5 * attempt, None)
            if status == 429:
                cooldown.defer(delay)
            retry = transient and attempt < attempts and deadline - cooldown.clock() > delay
            account(raw, True)
            emit({"phase": "error", "id": request["id"], "attempt": attempt, "status": status,
                  "errorType": type(error).__name__, "retry": retry,
                  "serviceError": provider_error_details(error), "retryAfter": retry_after,
                  "rateLimitCooldownSeconds": delay if status == 429 else None,
                  "retryDelaySeconds": delay if retry else None,
                  "partialResponse": raw,
                  "elapsedMs": round((time.monotonic() - started) * 1000),
                  "usage": raw.get("usage"), "usageStatus": "known" if usage_counts(raw.get("usage"))[0] else "unknown",
                  "diagnostics": dict(diagnostics)})
            if not retry:
                return {"id": request["id"], "status": status, "diagnostics": diagnostics,
                        "body": {"error": {"type": type(error).__name__, "attempts": attempt,
                                           "usageStatus": "unknown"}}}
            if status != 429:
                await cooldown.sleep(delay)


async def main():
    tasks = {}
    cooldown = ProviderCooldown()
    health = {"pid": os.getpid(), "startedAt": datetime.now(timezone.utc).isoformat(),
              "lastSuccessAt": None, "lastRequestAt": None, "lastFailureAt": None,
              "requests": 0, "successes": 0, "failures": 0}

    def publish_health():
        target = os.environ.get("DITTO_PROVIDER_LOG")
        if not target:
            return
        path = Path(target + ".health.json")
        temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps({**health, "active": len(tasks)}) + "\n", encoding="utf-8")
            os.replace(temporary, path)
        except OSError:
            pass

    publish_health()
    # SDK retries are disabled: every underlying attempt is explicitly logged above.
    async with AsyncOpenAI(api_key=os.environ.get("CODE_SOUL_API_KEY") or os.environ["DS_API_KEY"],
            base_url=os.environ.get("CODE_SOUL_BASE_URL", "https://api.deepseek.com"), max_retries=0) as client:
        async def invoke(request):
            health["requests"] += 1
            health["lastRequestAt"] = datetime.now(timezone.utc).isoformat()
            publish_health()
            result = await complete(client, request, request.get("timeoutMs", 600000), cooldown=cooldown)
            success = result["status"] == 200
            health["successes" if success else "failures"] += 1
            health["lastSuccessAt" if success else "lastFailureAt"] = datetime.now(timezone.utc).isoformat()
            publish_health()
            print(json.dumps(result, ensure_ascii=False), flush=True)

        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            request = json.loads(line)
            if request.get("cancel"):
                if request["id"] in tasks:
                    tasks[request["id"]].cancel()
                continue
            task = asyncio.create_task(invoke(request))
            tasks[request["id"]] = task
            task.add_done_callback(lambda _, key=request["id"]: tasks.pop(key, None))
        if tasks:
            await asyncio.gather(*list(tasks.values()))


if __name__ == "__main__":
    asyncio.run(main())
