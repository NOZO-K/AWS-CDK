from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


def _upload_dir() -> Path:
    # For containerized mode, point this to mounted storage (e.g. /data/uploads).
    return Path(os.getenv("UPLOAD_DIR", "/data/uploads")).resolve()


def _storage_backend() -> str:
    return os.getenv("STORAGE_BACKEND", "local").strip().lower()


def _s3_bucket() -> str:
    return os.getenv("S3_BUCKET", "").strip()


UPLOAD_DIR = _upload_dir()
if _storage_backend() == "local":
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Simple File API", version="1.0.0")


@app.get("/health")
def health() -> dict:
    return {"status": "healthy"}


@app.get("/", include_in_schema=False)
def root() -> RedirectResponse:
    return RedirectResponse(url="/upload", status_code=307)


@app.get("/upload", response_model=None)
def upload_page() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "pages" / "index.html").read_text(encoding="utf-8"))


@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    filename = Path(file.filename).name  # prevent path traversal
    if filename in (".", "..") or filename.strip() == "":
        raise HTTPException(status_code=400, detail="Invalid filename")

    try:
        data = await file.read()
    finally:
        await file.close()

    if _storage_backend() == "s3":
        bucket = _s3_bucket()
        if not bucket:
            raise HTTPException(status_code=500, detail="S3_BUCKET not configured")
        import boto3

        boto3.client("s3").put_object(Bucket=bucket, Key=filename, Body=data)
    else:
        dest = UPLOAD_DIR / filename
        dest.write_bytes(data)

    return JSONResponse({"filename": filename, "bytes": len(data)})


@app.get("/files", response_model=None)
def list_files(request: Request) -> Any:
    accept = (request.headers.get("accept") or "").lower()
    if "text/html" in accept and "application/json" not in accept:
        return HTMLResponse((STATIC_DIR / "pages" / "files.html").read_text(encoding="utf-8"))

    if _storage_backend() == "s3":
        bucket = _s3_bucket()
        if not bucket:
            raise HTTPException(status_code=500, detail="S3_BUCKET not configured")
        import boto3

        s3 = boto3.client("s3")
        response = s3.list_objects_v2(Bucket=bucket)
        files = [item["Key"] for item in response.get("Contents", []) if item.get("Key")]
    else:
        files = []
        for p in UPLOAD_DIR.iterdir():
            if p.is_file():
                files.append(p.name)

    files.sort()
    return {"files": files}


@app.delete("/files/{filename}")
def delete_file(filename: str) -> JSONResponse:
    safe = Path(filename).name  # prevent path traversal
    if safe in (".", "..") or safe.strip() == "":
        raise HTTPException(status_code=400, detail="Invalid filename")

    if _storage_backend() == "s3":
        bucket = _s3_bucket()
        if not bucket:
            raise HTTPException(status_code=500, detail="S3_BUCKET not configured")
        import boto3
        from botocore.exceptions import ClientError

        s3 = boto3.client("s3")
        try:
            s3.head_object(Bucket=bucket, Key=safe)
        except ClientError:
            raise HTTPException(status_code=404, detail="File not found")
        s3.delete_object(Bucket=bucket, Key=safe)
    else:
        target = UPLOAD_DIR / safe
        if not target.exists() or not target.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        target.unlink()

    return JSONResponse({"deleted": safe})


# Mount static UI last so it doesn't shadow API routes like /upload, /files, etc.
STATIC_DIR = Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
