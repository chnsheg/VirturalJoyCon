function normalizeHostTarget(hostTarget) {
  return String(hostTarget ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function clampPositive(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function optimizeVideoElement(videoEl) {
  if (!videoEl) {
    return;
  }

  videoEl.playsInline = true;
  videoEl.autoplay = true;
  videoEl.muted = true;
  videoEl.disablePictureInPicture = true;
  videoEl.disableRemotePlayback = true;
  videoEl.controls = false;
  videoEl.setAttribute?.("playsinline", "");
  videoEl.setAttribute?.("webkit-playsinline", "");
}

function applyLowLatencyReceiverHints(peer) {
  if (!peer || typeof peer.getReceivers !== "function") {
    return;
  }

  for (const receiver of peer.getReceivers() ?? []) {
    if (receiver?.track?.kind !== "video") {
      continue;
    }

    try {
      if ("playoutDelayHint" in receiver) {
        receiver.playoutDelayHint = 0;
      }
    } catch {}

    try {
      if ("jitterBufferTarget" in receiver) {
        receiver.jitterBufferTarget = 0;
      }
    } catch {}
  }
}

async function waitForIceGatheringComplete(peer) {
  if (!peer || peer.iceGatheringState === "complete" || typeof peer.addEventListener !== "function") {
    return;
  }

  await new Promise((resolve) => {
    const handleIceGatheringStateChange = () => {
      if (peer.iceGatheringState === "complete") {
        peer.removeEventListener?.("icegatheringstatechange", handleIceGatheringStateChange);
        resolve();
      }
    };

    peer.addEventListener("icegatheringstatechange", handleIceGatheringStateChange);
  });
}

export function buildWhepUrl(hostTarget) {
  return `http://${normalizeHostTarget(hostTarget)}/media/whep`;
}

export function computeContainRect({
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight,
}) {
  const safeSourceWidth = clampPositive(sourceWidth);
  const safeSourceHeight = clampPositive(sourceHeight);
  const safeTargetWidth = clampPositive(targetWidth);
  const safeTargetHeight = clampPositive(targetHeight);
  if (!safeSourceWidth || !safeSourceHeight || !safeTargetWidth || !safeTargetHeight) {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
  }

  const scale = Math.min(safeTargetWidth / safeSourceWidth, safeTargetHeight / safeSourceHeight);
  const width = safeSourceWidth * scale;
  const height = safeSourceHeight * scale;
  return {
    x: (safeTargetWidth - width) / 2,
    y: (safeTargetHeight - height) / 2,
    width,
    height,
  };
}

export function computeCoverRect({
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight,
}) {
  const safeSourceWidth = clampPositive(sourceWidth);
  const safeSourceHeight = clampPositive(sourceHeight);
  const safeTargetWidth = clampPositive(targetWidth);
  const safeTargetHeight = clampPositive(targetHeight);
  if (!safeSourceWidth || !safeSourceHeight || !safeTargetWidth || !safeTargetHeight) {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
  }

  const scale = Math.max(safeTargetWidth / safeSourceWidth, safeTargetHeight / safeSourceHeight);
  const width = safeSourceWidth * scale;
  const height = safeSourceHeight * scale;
  return {
    x: (safeTargetWidth - width) / 2,
    y: (safeTargetHeight - height) / 2,
    width,
    height,
  };
}

function syncCanvasSize(canvasEl, devicePixelRatio) {
  if (!canvasEl) {
    return { width: 0, height: 0 };
  }

  const cssWidth = Math.max(1, Math.round(canvasEl.clientWidth || canvasEl.width || 1));
  const cssHeight = Math.max(1, Math.round(canvasEl.clientHeight || canvasEl.height || 1));
  const safeDpr = Math.max(1, Number(devicePixelRatio) || 1);
  const pixelWidth = Math.max(1, Math.round(cssWidth * safeDpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * safeDpr));

  if (canvasEl.width !== pixelWidth) {
    canvasEl.width = pixelWidth;
  }
  if (canvasEl.height !== pixelHeight) {
    canvasEl.height = pixelHeight;
  }

  return {
    width: cssWidth,
    height: cssHeight,
    devicePixelRatio: safeDpr,
  };
}

function prepareCanvasContext(canvasEl, devicePixelRatio) {
  const context = canvasEl?.getContext?.("2d");
  if (!context) {
    return null;
  }

  const metrics = syncCanvasSize(canvasEl, devicePixelRatio);
  context.setTransform?.(metrics.devicePixelRatio, 0, 0, metrics.devicePixelRatio, 0, 0);
  return {
    context,
    width: metrics.width,
    height: metrics.height,
  };
}

function drawFrameToCanvas({ contextInfo, videoEl, rect }) {
  if (!contextInfo || !videoEl) {
    return;
  }

  const { context, width, height } = contextInfo;
  context.clearRect?.(0, 0, width, height);
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  context.drawImage?.(videoEl, rect.x, rect.y, rect.width, rect.height);
}

export function createStreamCanvasRenderer({
  videoEl,
  canvasEl,
  backdropCanvasEl,
  devicePixelRatioGetter = () => globalThis.devicePixelRatio || 1,
  requestAnimationFrameImpl = (callback) => globalThis.requestAnimationFrame?.(callback),
  cancelAnimationFrameImpl = (handle) => globalThis.cancelAnimationFrame?.(handle),
} = {}) {
  let animationHandle = null;
  let videoFrameHandle = null;
  let running = false;

  const paintFrame = () => {
    const safeDpr = devicePixelRatioGetter();
    const sourceWidth = clampPositive(videoEl?.videoWidth);
    const sourceHeight = clampPositive(videoEl?.videoHeight);

    if (sourceWidth > 0 && sourceHeight > 0) {
      const foregroundContext = prepareCanvasContext(canvasEl, safeDpr);
      const backdropContext = prepareCanvasContext(backdropCanvasEl, safeDpr);

      if (backdropContext) {
        drawFrameToCanvas({
          contextInfo: backdropContext,
          videoEl,
          rect: computeCoverRect({
            sourceWidth,
            sourceHeight,
            targetWidth: backdropContext.width,
            targetHeight: backdropContext.height,
          }),
        });
      }

      if (foregroundContext) {
        drawFrameToCanvas({
          contextInfo: foregroundContext,
          videoEl,
          rect: computeContainRect({
            sourceWidth,
            sourceHeight,
            targetWidth: foregroundContext.width,
            targetHeight: foregroundContext.height,
          }),
        });
      }
    }
  };

  const scheduleNextFrame = () => {
    if (!running) {
      return;
    }

    if (typeof videoEl?.requestVideoFrameCallback === "function") {
      videoFrameHandle = videoEl.requestVideoFrameCallback(() => {
        videoFrameHandle = null;
        paintFrame();
        scheduleNextFrame();
      });
      return;
    }

    animationHandle = requestAnimationFrameImpl?.(() => {
      animationHandle = null;
      paintFrame();
      scheduleNextFrame();
    }) ?? null;
  };

  return {
    drawFrame() {
      paintFrame();
    },
    start() {
      if (running) {
        return;
      }

      running = true;
      scheduleNextFrame();
    },
    stop() {
      running = false;
      if (animationHandle !== null) {
        cancelAnimationFrameImpl?.(animationHandle);
        animationHandle = null;
      }
      if (videoFrameHandle !== null) {
        videoEl?.cancelVideoFrameCallback?.(videoFrameHandle);
        videoFrameHandle = null;
      }
    },
  };
}

export async function attachRemoteStream(videoEl, stream) {
  if (!videoEl) {
    return undefined;
  }

  optimizeVideoElement(videoEl);
  videoEl.hidden = false;
  videoEl.classList?.remove?.("remote-video-hidden");
  videoEl.srcObject = stream;
  return videoEl.play?.().catch(() => undefined);
}

function createFallbackRemoteStreamFactory(mediaStreamFactory = () => new globalThis.MediaStream()) {
  let fallbackStream = null;

  return (event) => {
    const explicitStream = event?.streams?.[0];
    if (explicitStream) {
      fallbackStream = explicitStream;
      return explicitStream;
    }

    if (!fallbackStream) {
      fallbackStream = mediaStreamFactory();
    }

    if (event?.track && typeof fallbackStream?.addTrack === "function") {
      const existingTracks = typeof fallbackStream.getTracks === "function"
        ? fallbackStream.getTracks()
        : fallbackStream.tracks ?? [];
      const alreadyAdded = existingTracks.some((track) => track?.id && track.id === event.track.id);
      if (!alreadyAdded) {
        fallbackStream.addTrack(event.track);
      }
    }

    return fallbackStream;
  };
}

export async function subscribeViaWhep({
  hostTarget,
  videoEl,
  fetchImpl = fetch,
  peerFactory = () => new globalThis.RTCPeerConnection(),
  mediaStreamFactory = () => new globalThis.MediaStream(),
}) {
  const peer = peerFactory();
  const resolveRemoteStream = createFallbackRemoteStreamFactory(mediaStreamFactory);
  peer.addTransceiver("video", { direction: "recvonly" });

  peer.ontrack = (event) => {
    void attachRemoteStream(videoEl, resolveRemoteStream(event));
  };

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitForIceGatheringComplete(peer);
  const description = peer.localDescription ?? offer;

  const response = await fetchImpl(buildWhepUrl(hostTarget), {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: description.sdp,
  });
  if (!response?.ok) {
    throw new Error(`whep_${response?.status ?? "error"}`);
  }

  const answerSdp = await response.text();
  await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
  applyLowLatencyReceiverHints(peer);
  return peer;
}
