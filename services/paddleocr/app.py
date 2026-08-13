"""Small local HTTP wrapper around PaddleOCR's general OCR pipeline.

This is intentionally an observation service: it accepts one image, returns
only recognised lines and geometry, and knows nothing about the expense API.
"""

from __future__ import annotations

from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile
from paddleocr import PaddleOCR
from pydantic import BaseModel

app = FastAPI(title="Local PaddleOCR", docs_url=None, redoc_url=None)

# These optional modules increase startup and inference work. The fixture proof
# of concept passes without them, so keep the smallest documented configuration.
ocr = PaddleOCR(
    lang="en",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
)

SUPPORTED_TYPES = {"image/jpeg", "image/png", "image/webp"}


class Point(BaseModel):
    x: int
    y: int


class OcrLine(BaseModel):
    text: str
    polygon: list[Point]
    confidence: float


class OcrResponse(BaseModel):
    lines: list[OcrLine]


def reading_order(line: OcrLine) -> tuple[int, int]:
    return (min(point.y for point in line.polygon), min(point.x for point in line.polygon))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ocr", response_model=OcrResponse)
async def read_receipt(
    image: Annotated[UploadFile, File(description="One JPEG, PNG, or WebP receipt image")],
) -> OcrResponse:
    if image.content_type not in SUPPORTED_TYPES:
        raise HTTPException(status_code=415, detail="Only JPEG, PNG, and WebP images are supported")

    suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[image.content_type]
    with NamedTemporaryFile(suffix=suffix) as temporary:
        temporary.write(await image.read())
        temporary.flush()
        result = next(ocr.predict(Path(temporary.name)))

    lines = [
        OcrLine(
            text=str(text),
            polygon=[Point(x=int(point[0]), y=int(point[1])) for point in polygon],
            confidence=float(score),
        )
        for text, polygon, score in zip(
            result["rec_texts"], result["rec_polys"], result["rec_scores"], strict=True
        )
        if str(text).strip()
    ]

    return OcrResponse(lines=sorted(lines, key=reading_order))
