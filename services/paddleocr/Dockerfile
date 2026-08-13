FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /service

# OpenCV and PaddlePaddle need OpenGL, GLib's thread runtime, and GNU OpenMP
# on a Debian slim image.
RUN apt-get update && apt-get install --no-install-recommends -y libgl1 libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8008
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8008"]
