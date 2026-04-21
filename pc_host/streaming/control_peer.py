from __future__ import annotations


class ControlPeerFactory:
    async def answer_offer(self, offer_sdp: str, offer_type: str = "offer") -> dict[str, str]:
        from aiortc import RTCPeerConnection, RTCSessionDescription

        peer = RTCPeerConnection()

        @peer.on("datachannel")
        def on_datachannel(channel) -> None:
            if channel.label != "joycon.control.v1":
                return

            @channel.on("message")
            def on_message(message) -> None:
                if isinstance(message, str) and message == "ping":
                    channel.send("pong")

        await peer.setRemoteDescription(
            RTCSessionDescription(sdp=offer_sdp, type=offer_type)
        )
        answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        return {
            "sdp": peer.localDescription.sdp,
            "type": peer.localDescription.type,
        }
