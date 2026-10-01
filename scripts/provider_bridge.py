"""Use the same installed OpenAI Python SDK as frozen AFlow for HTTP/retries."""
import asyncio
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from openai import AsyncOpenAI, APIStatusError, APIConnectionError, APITimeoutError


def log(record):
    target = os.environ.get("DITTO_PROVIDER_LOG")
    if target:
        path = Path(target)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), **record}) + "\n")


async def main():
    tasks = set()
    clients = []
    health = {"pid": os.getpid(), "startedAt": datetime.now(timezone.utc).isoformat(),
              "lastSuccessAt": None, "lastRequestAt": None, "lastFailureAt": None,
              "requests": 0, "successes": 0, "failures": 0, "clientRefreshes": 0}
    last_health_write = 0.0

    def make_client():
        entry = {"sdk": AsyncOpenAI(api_key=os.environ["CODE_SOUL_API_KEY"],
                                    base_url=os.environ["CODE_SOUL_BASE_URL"]),
                 "active": 0, "failures": 0, "generation": len(clients) + 1, "retired": False}
        clients.append(entry)
        return entry

    client = make_client()

    def publish_health(force=False):
        nonlocal last_health_write
        target = os.environ.get("DITTO_PROVIDER_LOG")
        if not target or (not force and time.monotonic() - last_health_write < 2):
            return
        path = Path(target + ".health.json")
        temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps({"at": datetime.now(timezone.utc).isoformat(),
                **health, "active": sum(entry["active"] for entry in clients),
                "currentClientGeneration": client["generation"]}) + "\n", encoding="utf-8")
            os.replace(temporary, path)
            last_health_write = time.monotonic()
        except OSError:
            # Telemetry must not break successful requests when Windows
            # readers briefly deny replacement of an open status file.
            pass

    async def invoke(request):
        nonlocal client
        started = time.monotonic()
        body = request["body"]
        entry = client
        entry["active"] += 1
        health["requests"] += 1
        health["lastRequestAt"] = datetime.now(timezone.utc).isoformat()
        publish_health()
        digest = hashlib.sha256(json.dumps(body.get("messages"), ensure_ascii=False).encode()).hexdigest()
        log({"phase": "request", "id": request["id"], "promptHash": digest, "model": body["model"],
             "max_tokens": body.get("max_tokens"), "temperature": body.get("temperature"), "top_p": body.get("top_p"),
             "clientGeneration": entry["generation"]})
        try:
            response = await entry["sdk"].chat.completions.create(**body)
            entry["failures"] = 0
            health["successes"] += 1
            health["lastSuccessAt"] = datetime.now(timezone.utc).isoformat()
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
            health["failures"] += 1
            health["lastFailureAt"] = datetime.now(timezone.utc).isoformat()
            status = error.status_code if isinstance(error, APIStatusError) else 599
            result = {"id": request["id"], "status": status, "body": {"error": {"type": type(error).__name__}}}
            log({"phase": "error", "id": request["id"], "status": status,
                 "errorType": type(error).__name__, "causeType": type(error.__cause__).__name__,
                 "clientGeneration": entry["generation"]})
            if isinstance(error, (APIConnectionError, APITimeoutError)):
                entry["failures"] += 1
                if entry is client and entry["failures"] >= 3:
                    entry["retired"] = True
                    client = make_client()
                    health["clientRefreshes"] += 1
                    log({"phase": "client-refreshed", "oldGeneration": entry["generation"],
                         "newGeneration": client["generation"], "reason": type(error).__name__})
                    # In-flight calls retain the old client. This does not
                    # change generation parameters or add retry attempts.
        finally:
            entry["active"] -= 1
            if entry["retired"] and entry["active"] == 0:
                await entry["sdk"].close()
            publish_health()
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
        for entry in clients:
            await entry["sdk"].close()
        publish_health(force=True)


if __name__ == "__main__":
    asyncio.run(main())
