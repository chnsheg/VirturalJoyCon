from __future__ import annotations


class ControlPeerFactory:
    @staticmethod
    def accepts_control_channel(channel) -> bool:
        return (
            getattr(channel, "label", None) == "joycon.control.v1"
            and getattr(channel, "ordered", False) is True
            and getattr(channel, "maxRetransmits", None) is None
            and getattr(channel, "maxPacketLifeTime", None) is None
        )

    def configure_control_channel(self, channel) -> bool:
        if self.accepts_control_channel(channel):
            @channel.on("message")
            def on_message(message) -> None:
                if isinstance(message, str) and message == "ping":
                    channel.send("pong")

            return True

        if getattr(channel, "label", None) == "joycon.control.v1":
            close = getattr(channel, "close", None)
            if callable(close):
                close()
        return False

    async def answer_offer(self, offer_sdp: str, offer_type: str = "offer") -> dict[str, str]:
        from aiortc import RTCPeerConnection, RTCSessionDescription

        peer = RTCPeerConnection()

        @peer.on("datachannel")
        def on_datachannel(channel) -> None:
            self.configure_control_channel(channel)

        await peer.setRemoteDescription(
            RTCSessionDescription(sdp=offer_sdp, type=offer_type)
        )
        answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        return {
            "sdp": peer.localDescription.sdp,
            "type": peer.localDescription.type,
        }
