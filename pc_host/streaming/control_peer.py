from __future__ import annotations

import inspect


class ControlPeerFactory:
    def __init__(
        self,
        peer_factory=None,
        session_description_factory=None,
    ) -> None:
        self._peer_factory = peer_factory
        self._session_description_factory = session_description_factory
        self.active_peers: set[object] = set()

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

    def _create_peer(self):
        if self._peer_factory is not None:
            return self._peer_factory()

        from aiortc import RTCPeerConnection

        return RTCPeerConnection()

    def _create_session_description(self, *, sdp: str, type: str):
        if self._session_description_factory is not None:
            return self._session_description_factory(sdp=sdp, type=type)

        from aiortc import RTCSessionDescription

        return RTCSessionDescription(sdp=sdp, type=type)

    async def _close_peer(self, peer) -> None:
        close = getattr(peer, "close", None)
        if not callable(close):
            return

        result = close()
        if inspect.isawaitable(result):
            await result

    async def _handle_connection_state_change(self, peer) -> None:
        state = getattr(peer, "connectionState", None)
        if state == "failed":
            await self._close_peer(peer)
            self.active_peers.discard(peer)
            return

        if state == "closed":
            self.active_peers.discard(peer)

    async def close_all(self) -> None:
        peers = list(self.active_peers)
        self.active_peers.clear()
        for peer in peers:
            await self._close_peer(peer)

    async def answer_offer(self, offer_sdp: str, offer_type: str = "offer") -> dict[str, str]:
        peer = self._create_peer()
        self.active_peers.add(peer)

        @peer.on("datachannel")
        def on_datachannel(channel) -> None:
            self.configure_control_channel(channel)

        @peer.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            await self._handle_connection_state_change(peer)

        try:
            await peer.setRemoteDescription(
                self._create_session_description(sdp=offer_sdp, type=offer_type)
            )
            answer = await peer.createAnswer()
            await peer.setLocalDescription(answer)
            return {
                "sdp": peer.localDescription.sdp,
                "type": peer.localDescription.type,
            }
        except Exception:
            self.active_peers.discard(peer)
            try:
                await self._close_peer(peer)
            except Exception:
                pass
            raise
