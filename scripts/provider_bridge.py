"""Use the same installed OpenAI Python SDK as frozen AFlow for HTTP/retries."""
import asyncio
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from openai import AsyncOpenAI, APIStatusError


def log(record):
    target = os.environ.get("DITTO_PROVIDER_LOG")
    if target:
        path = Path(target)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), **record}) + "\n")


async def main():
    client = AsyncOpenAI(api_key=os.environ["CODE_SOUL_API_KEY"], base_url=os.environ["CODE_SOUL_BASE_URL"])
    tasks = set()

    async def invoke(request):
        started = time.monotonic()
        body = request["body"]
        digest = hashlib.sha256(json.dumps(body.get("messages"), ensure_ascii=False).encode()).hexdigest()
        log({"phase": "request", "id": request["id"], "promptHash": digest, "model": body["model"],
             "max_tokens": body.get("max_tokens"), "temperature": body.get("temperature"), "top_p": body.get("top_p")})
        try:
            response = await client.chat.completions.create(**body)
            # Ditto's OpenAI-compatible parser treats an explicitly-null
            # tool_calls field as malformed, while the OpenAI wire format
            # permits providers/SDKs to materialize absent optional fields as
            # null. Preserve wire semantics by omitting every absent field.
            raw = response.model_dump(exclude_none=True)
            result = {"id": request["id"], "status": 200, "body": raw}
            log({"phase": "response", "id": request["id"], "elapsedMs": round((time.monotonic()-started)*1000),
                 "model": raw.get("model"), "fingerprint": raw.get("system_fingerprint"), "usage": raw.get("usage"),
                 "finishReason": raw["choices"][0].get("finish_reason"),
                 "contentChars": len(raw["choices"][0]["message"].get("content") or "")})
        except Exception as error:
            status = error.status_code if isinstance(error, APIStatusError) else 599
            result = {"id": request["id"], "status": status, "body": {"error": {"type": type(error).__name__}}}
            log({"phase": "error", "id": request["id"], "status": status, "errorType": type(error).__name__})
        print(json.dumps(result, ensure_ascii=False), flush=True)

    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            task = asyncio.create_task(invoke(json.loads(line)))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
        if tasks:
            await asyncio.gather(*tasks)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
