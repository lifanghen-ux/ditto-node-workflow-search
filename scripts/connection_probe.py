"""Small live transport probe. Never prints model keys or raw prompts."""
import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
import argparse
import httpx
from openai import AsyncOpenAI


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    for line in Path(args.env_file).read_text(encoding="utf-8-sig").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip()
    reports = []
    # Both arms use the same fresh SDK, model and key. The only diagnostic
    # variable is whether HTTP keep-alive connections may be pooled.
    for pooled in [True, False]:
        transport = httpx.AsyncClient(
            timeout=httpx.Timeout(45.0, connect=5.0),
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=16 if pooled else 0),
        )
        client = AsyncOpenAI(api_key=os.environ["CODE_SOUL_API_KEY"],
            base_url=os.environ["CODE_SOUL_BASE_URL"], http_client=transport, max_retries=0)
        try:
            async def probe(index):
                start = time.monotonic()
                try:
                    response = await client.chat.completions.create(
                        model=os.environ["CODE_SOUL_MODEL"], temperature=0.2, top_p=1,
                        max_tokens=128, messages=[{"role": "user", "content": "What is 2 + 2? Answer with the number only."}])
                    return {"pooled": pooled, "index": index, "ok": True,
                        "elapsedMs": round((time.monotonic()-start)*1000),
                        "model": response.model, "finishReason": response.choices[0].finish_reason,
                        "contentPresent": bool(response.choices[0].message.content)}
                except Exception as error:
                    return {"pooled": pooled, "index": index, "ok": False,
                        "elapsedMs": round((time.monotonic()-start)*1000),
                        "errorType": type(error).__name__, "causeType": type(error.__cause__).__name__,
                        "httpStatus": getattr(error, "status_code", None)}
            # Check serial reuse followed by concurrent requests, without
            # solving any search/test question or changing evaluation rules.
            reports.append(await probe(1))
            reports.append(await probe(2))
            reports.extend(await asyncio.gather(probe(3), probe(4)))
        finally:
            await client.close()
    record = {"at": datetime.now(timezone.utc).isoformat(), "probes": reports,
        "allPassed": all(report["ok"] for report in reports)}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(record, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(record))
    if not record["allPassed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
