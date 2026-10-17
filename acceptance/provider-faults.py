"""Additional offline acceptance; reuse the existing SDK mock and clock fixtures."""
import sys
import unittest
from pathlib import Path
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import provider_bridge_test as fixtures
from provider_bridge_test import FakeTime, sse, chunk


class MeetingProviderFaults(unittest.IsolatedAsyncioTestCase):
    invoke = fixtures.ProviderBridgeTests.invoke

    async def test_401_402_are_terminal_and_record_unknown_usage(self):
        for status in (401, 402):
            with self.subTest(status=status):
                reply, records = await self.invoke(lambda _: httpx.Response(status, json={"error": {"message": "fixture"}}))
                self.assertEqual(reply["status"], status)
                self.assertEqual([r["phase"] for r in records], ["request", "error"])
                self.assertFalse(records[-1]["retry"])
                self.assertEqual(records[-1]["status"], status)
                self.assertEqual(records[-1]["usageStatus"], "unknown")
                self.assertEqual(reply["diagnostics"]["attempts"], 1)
                self.assertEqual(reply["diagnostics"]["unknownUsageAttempts"], 1)

    async def test_500_and_sdk_timeout_recover_and_exhaust_finitely(self):
        for name, status in (("500", 500), ("timeout", 504)):
            for recover in (True, False):
                with self.subTest(fault=name, recover=recover):
                    calls = 0
                    def handler(request):
                        nonlocal calls
                        calls += 1
                        if recover and calls > 1:
                            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=sse([
                                chunk({"content": "ok"}, "stop"), chunk(usage={"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7})]))
                        if name == "timeout":
                            raise httpx.ReadTimeout("fixture read timeout", request=request)
                        return httpx.Response(500, json={"error": {"message": "fixture"}})
                    fake = FakeTime()
                    reply, records = await self.invoke(handler, timeout=600000, cooldown=fake.cooldown())
                    self.assertEqual(calls, 2 if recover else 3)
                    self.assertEqual(reply["status"], 200 if recover else status)
                    errors = [r for r in records if r["phase"] == "error"]
                    self.assertEqual([r["retry"] for r in errors], [True] if recover else [True, True, False])
                    self.assertTrue(all(r["status"] == status and r["usageStatus"] == "unknown" for r in errors))
                    self.assertEqual(reply["diagnostics"]["attempts"], calls)
                    self.assertEqual(reply["diagnostics"]["unknownUsageAttempts"], len(errors))
                    self.assertEqual(reply["diagnostics"]["totalTokens"], 7 if recover else 0)
                    self.assertFalse(reply["diagnostics"]["usageKnown"])


if __name__ == "__main__":
    unittest.main()
