function normalizeHostTarget(hostTarget) {
  return String(hostTarget ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
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
  const [host] = normalizeHostTarget(hostTarget).split(":");
  return `http://${host}:8889/game/whep`;
}

export async function attachRemoteStream(videoEl, stream) {
  if (!videoEl) {
    return undefined;
  }

  videoEl.srcObject = stream;
  return videoEl.play?.().catch(() => undefined);
}

export async function subscribeViaWhep({
  hostTarget,
  videoEl,
  fetchImpl = fetch,
  peerFactory = () => new globalThis.RTCPeerConnection(),
}) {
  const peer = peerFactory();
  peer.addTransceiver("video", { direction: "recvonly" });
  peer.addTransceiver("audio", { direction: "recvonly" });

  peer.ontrack = (event) => {
    void attachRemoteStream(videoEl, event.streams?.[0]);
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
  return peer;
}
