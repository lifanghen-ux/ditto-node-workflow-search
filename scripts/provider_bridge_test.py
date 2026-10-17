"""Offline SDK/stream tests; no network or credentials are used."""
import asyncio
import json
import unittest

import httpx
from openai import AsyncOpenAI
from provider_bridge import complete, request_body, report_progress, usage_counts, ProviderCooldown


class FakeTime:
    def __init__(self):
        self.now = 0
        self.delays = []

    def clock(self):
        return self.now

    async def sleep(self, seconds):
        self.delays.append(seconds)
        self.now += seconds
        await asyncio.sleep(0)

    def cooldown(self):
        return ProviderCooldown(self.clock, self.sleep, lambda: 0)


def sse(parts):
    return "".join("data: " + json.dumps(part) + "\n\n" for part in parts) + "data: [DONE]\n\n"


def chunk(delta=None, reason=None, usage=None):
    result = {"id": "fixture", "model": "fixture", "choices": []}
    if delta is not None or reason:
        result["choices"] = [{"index": 0, "delta": delta or {}, "finish_reason": reason}]
    if usage:
        result["usage"] = usage
    return result


class ProviderBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, handler, timeout=3000, cooldown=None):
        records = []
        async with AsyncOpenAI(api_key="fixture", base_url="https://fixture.invalid", max_retries=0,
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as client:
            reply = await complete(client, {"id": 1, "body": {"model": "fixture", "messages": []}}, timeout, records.append, cooldown=cooldown)
        return reply, records

    async def test_fragmented_content_tools_usage_and_protocol(self):
        def handler(request):
            body = json.loads(request.content)
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertEqual((body["temperature"], body["max_tokens"], body["n"], body["stream"]), (0, 393216, 1, True))
            self.assertEqual(body["response_format"], {"type": "text"})
            self.assertNotIn("top_p", body)
            self.assertNotIn("reasoning_effort", body)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=sse([
                chunk({"content": "hel", "tool_calls": [{"index": 1, "id": "b", "type": "function", "function": {"name": "second", "arguments": "{"}}]}),
                chunk({"content": "lo", "tool_calls": [{"index": 0, "id": "a", "type": "function", "function": {"name": "first", "arguments": "{}"}}, {"index": 1, "function": {"arguments": "\"x\":1}"}}]}),
                chunk(reason="tool_calls"), chunk(usage={"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7})]))
        reply, records = await self.invoke(handler)
        choice = reply["body"]["choices"][0]
        self.assertEqual(choice["message"]["content"], "hello")
        self.assertEqual([call["id"] for call in choice["message"]["tool_calls"]], ["a", "b"])
        self.assertEqual(choice["message"]["tool_calls"][1]["function"]["arguments"], '{"x":1}')
        self.assertEqual(reply["body"]["usage"]["total_tokens"], 7)
        self.assertEqual(records[-1]["usageStatus"], "known")
        self.assertTrue(reply["diagnostics"]["usageKnown"])
        self.assertEqual(reply["diagnostics"]["totalTokens"], 7)

    async def test_length_is_preserved_without_retry(self):
        reply, records = await self.invoke(lambda _: httpx.Response(200, headers={"content-type": "text/event-stream"}, text=sse([chunk({"content": "partial"}, "length")])))
        self.assertEqual(reply["body"]["choices"][0]["finish_reason"], "length")
        self.assertEqual(records[-1]["usageStatus"], "unknown")
        self.assertFalse(reply["diagnostics"]["usageKnown"])
        self.assertEqual(reply["diagnostics"]["unknownUsageAttempts"], 1)

    async def test_unterminated_stream_retries_each_unknown_usage_attempt(self):
        reply, records = await self.invoke(lambda _: httpx.Response(200, headers={"content-type": "text/event-stream"}, text=sse([chunk({"content": "partial"})])))
        self.assertEqual(reply["status"], 502)
        errors = [record for record in records if record["phase"] == "error"]
        self.assertEqual([record["attempt"] for record in errors], [1, 2, 3])
        self.assertTrue(all(record["usageStatus"] == "unknown" for record in errors))
        self.assertEqual(errors[-1]["errorType"], "StreamIncompleteError")

    async def test_balance_auth_and_parameter_errors_are_not_retried(self):
        for status in (400, 401, 402, 403, 422):
            reply, records = await self.invoke(lambda _, status=status: httpx.Response(status, json={"error": {"message": "fixture"}}))
            self.assertEqual(reply["status"], status)
            self.assertEqual(len([item for item in records if item["phase"] == "request"]), 1)
            self.assertEqual(records[-1]["usageStatus"], "unknown")

    async def test_transient_http_failure_then_success_keeps_both_attempts(self):
        calls = 0
        def handler(_):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(429, json={"error": {"message": "fixture"}})
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=sse([chunk({"content": "ok"}, "stop"), chunk(usage={"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7})]))
        fake = FakeTime()
        reply, records = await self.invoke(handler, timeout=600000, cooldown=fake.cooldown())
        self.assertEqual(reply["status"], 200)
        self.assertEqual(calls, 2)
        self.assertEqual(fake.delays, [10])
        self.assertEqual([item["phase"] for item in records], ["request", "error", "request", "response"])
        self.assertEqual(reply["diagnostics"], {"requestId": 1, "attempts": 2, "failedAttempts": 1,
                         "unknownUsageAttempts": 1, "usageKnown": False,
                         "inputTokens": 3, "outputTokens": 4, "totalTokens": 7})

    async def test_rate_limit_backoff_is_ten_twenty_seconds_and_at_most_three_attempts(self):
        fake = FakeTime()
        reply, records = await self.invoke(lambda _: httpx.Response(429, json={"error": {"code": "RateLimitExceeded", "message": "busy"}}),
                                           timeout=600000, cooldown=fake.cooldown())
        self.assertEqual(reply["status"], 429)
        self.assertEqual(fake.delays, [10, 20])
        self.assertEqual(reply["diagnostics"]["attempts"], 3)
        errors = [item for item in records if item["phase"] == "error"]
        self.assertEqual([item["retry"] for item in errors], [True, True, False])
        self.assertEqual(errors[0]["serviceError"], {"code": "RateLimitExceeded", "message": "busy"})

    async def test_retry_after_and_shared_cooldown_delay_new_requests_without_header_leaks(self):
        fake = FakeTime()
        cooldown = fake.cooldown()
        seen = []
        def handler(request):
            seen.append(fake.now)
            if len(seen) == 1:
                return httpx.Response(429, headers={"Retry-After": "12", "Authorization": "PRIVATE_HEADER"},
                    json={"error": {"code": "rate_limit", "message": "retry later", "request_body": "PRIVATE_BODY"}})
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=sse([chunk({"content": "ok"}, "stop")]))
        records = []
        async with AsyncOpenAI(api_key="PRIVATE_KEY", base_url="https://fixture.invalid", max_retries=0,
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as client:
            first = await complete(client, {"id": 1, "body": {"model": "fixture", "messages": []}}, 600000, records.append, attempts=1, cooldown=cooldown)
            second = await complete(client, {"id": 2, "body": {"model": "fixture", "messages": []}}, 600000, records.append, cooldown=cooldown)
        self.assertEqual(first["status"], 429)
        self.assertEqual(second["status"], 200)
        self.assertEqual(seen, [0, 12])
        error = next(item for item in records if item["phase"] == "error")
        self.assertEqual(error["retryAfter"], 12)
        for secret in ("PRIVATE_HEADER", "PRIVATE_BODY", "PRIVATE_KEY"):
            self.assertNotIn(secret, json.dumps(records))

    async def test_retry_after_cannot_exceed_total_deadline_and_is_capped(self):
        fake = FakeTime()
        reply, records = await self.invoke(lambda _: httpx.Response(429, headers={"Retry-After": "999999"}, json={"error": {"message": "busy"}}),
                                           timeout=20000, cooldown=fake.cooldown())
        self.assertEqual(reply["status"], 429)
        self.assertEqual(fake.delays, [])
        self.assertEqual(reply["diagnostics"]["attempts"], 1)
        self.assertEqual(records[-1]["retryAfter"], 999999)
        self.assertEqual(records[-1]["rateLimitCooldownSeconds"], 300)
        self.assertFalse(records[-1]["retry"])

    async def test_http_date_retry_after_is_observed(self):
        fake = FakeTime()
        calls = 0
        def handler(_):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(429, headers={"Retry-After": "Thu, 01 Jan 1970 00:00:25 GMT"}, json={"error": {"message": "busy"}})
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=sse([chunk({"content": "ok"}, "stop")]))
        reply, records = await self.invoke(handler, timeout=600000, cooldown=fake.cooldown())
        self.assertEqual(reply["status"], 200)
        self.assertEqual(fake.delays, [25])
        self.assertEqual(next(item for item in records if item["phase"] == "error")["retryAfter"], 25)

    async def test_cancel_during_shared_cooldown_is_terminal_without_fake_http_attempt(self):
        async def cancel_sleep(_):
            raise asyncio.CancelledError()
        cooldown = ProviderCooldown(lambda: 0, cancel_sleep)
        cooldown.defer(10)
        def handler(_):
            self.fail("HTTP must not be sent during cancelled cooldown")
        reply, records = await self.invoke(handler, timeout=600000, cooldown=cooldown)
        self.assertEqual(reply["status"], 499)
        self.assertEqual(reply["diagnostics"]["attempts"], 0)

    async def test_progress_reports_stalled_stream_without_chunk_contents(self):
        records = []
        progress = {"chunks": 2, "contentChars": 10, "lastChunkAt": None}
        task = asyncio.create_task(report_progress(1, 2, 0, progress, records.append, interval=0.01))
        await asyncio.sleep(0.03)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertGreaterEqual(len(records), 1)
        self.assertEqual(records[0]["phase"], "stream-progress")
        self.assertEqual(records[0]["chunks"], 2)
        self.assertEqual(records[0]["contentChars"], 10)
        self.assertNotIn("response", records[0])

    def test_empty_or_partial_usage_is_unknown_even_on_success(self):
        for usage in (None, {}, {"total_tokens": 7}, {"prompt_tokens": 3}):
            self.assertFalse(usage_counts(usage)[0])
        self.assertEqual(usage_counts({"prompt_tokens": 0, "completion_tokens": 0}), (True, 0, 0, 0))

    async def test_total_deadline_bounds_stream_consumption(self):
        async def handler(_):
            await asyncio.sleep(0.1)
            return httpx.Response(200)
        reply, records = await self.invoke(handler, timeout=10)
        self.assertEqual(reply["status"], 504)
        self.assertEqual(records[-1]["errorType"], "TimeoutError")
        self.assertFalse(records[-1]["retry"])

    async def test_cancel_is_terminal_and_usage_unknown(self):
        async def handler(_):
            raise asyncio.CancelledError()
        reply, records = await self.invoke(handler)
        self.assertEqual(reply["status"], 499)
        self.assertFalse(records[-1]["retry"])

    def test_overrides_cannot_restore_forbidden_parameters(self):
        result = request_body({"top_p": 1, "reasoning_effort": "high", "max_completion_tokens": 128,
                               "extra_body": {"top_p": 0.9, "reasoning_effort": "high", "stream": False,
                                              "temperature": 1, "max_tokens": 128}})
        self.assertNotIn("top_p", result)
        self.assertNotIn("reasoning_effort", result["extra_body"])
        self.assertNotIn("max_completion_tokens", result)
        self.assertEqual(result["extra_body"], {"thinking": {"type": "disabled"}})


if __name__ == "__main__":
    unittest.main()
