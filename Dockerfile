# Bonsai Rehabilitation Center — Node 20 + Python (gait CV) runtime
# Used by Render (and docker) to run the full site including the Gait Lab
# computer-vision analyzer. CompileSdk-style heavy deps are Python-only.

FROM node:20-bookworm-slim

# Python + build tools for native deps (better-sqlite3, mediapipe wheels)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

# Python deps for gait analysis (CPU-only MediaPipe pose estimation)
ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Node deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund

# App source
COPY . .

ENV NODE_ENV=production
ENV GAIT_PYTHON=$VIRTUAL_ENV/bin/python
EXPOSE 3000

CMD ["npm", "start"]