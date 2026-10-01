"""Offline connection-refresh test; no network or real model key."""
import asyncio
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import unittest
import httpx
from openai import APIConnectionError

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("provider_bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTest(unittest.TestCase):
    def test_refreshes_client_without_retrying_the_same_request(self):
        clients = []

        class FakeClient:
            def __init__(self, **kwargs):
                self.generation = len(clients) + 1
                self.calls = 0
                self.closed = False
                clients.append(self)
                self.chat = SimpleNamespace(completions=self)

            async def create(self, **body):
                self.calls += 1
                if self.generation == 1:
                    raise APIConnectionError(request=httpx.Request("POST", "https://example.invalid"))
                return SimpleNamespace(model_dump=lambda **kwargs: {"choices": [{"message": {"content": "4"}, "finish_reason": "stop"}]})

            async def close(self):
                self.closed = True

        requests = "".join(json.dumps({"id": index, "body": {"model": "fixture", "messages": []}})+"\n" for index in range(1, 5))
        output = io.StringIO()
        with patch.object(bridge, "AsyncOpenAI", FakeClient), patch.object(bridge.sys, "stdin", io.StringIO(requests)), \
             patch.object(bridge.sys, "stdout", output), patch.dict(os.environ, {"CODE_SOUL_API_KEY": "fixture", "CODE_SOUL_BASE_URL": "https://example.invalid", "DITTO_PROVIDER_LOG": ""}):
            asyncio.run(bridge.main())
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([reply["status"] for reply in replies], [599, 599, 599, 200])
        self.assertEqual([client.calls for client in clients], [3, 1])
        self.assertTrue(all(client.closed for client in clients))


if __name__ == "__main__":
    unittest.main()
