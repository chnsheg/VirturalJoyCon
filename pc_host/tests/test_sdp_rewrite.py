import unittest

from streaming.sdp_rewrite import (
    describe_host_candidates,
    filter_or_rewrite_media_answer,
    rewrite_control_answer_host_candidates,
)


class SdpRewriteTests(unittest.TestCase):
    def test_media_helper_keeps_only_candidates_matching_the_requested_host(self) -> None:
        answer = "\r\n".join(
            [
                "v=0",
                "a=candidate:1 1 UDP 2122252543 10.0.0.7 8189 typ host",
                "a=candidate:2 1 UDP 2122252543 192.168.0.112 8189 typ host",
                "a=end-of-candidates",
                "",
            ]
        )

        filtered = filter_or_rewrite_media_answer(answer, preferred_host="192.168.0.112:8082")

        self.assertIn("192.168.0.112 8189 typ host", filtered)
        self.assertNotIn("10.0.0.7 8189 typ host", filtered)
        self.assertIn("a=end-of-candidates", filtered)
        self.assertTrue(filtered.endswith("\r\n"))

    def test_control_helper_rewrites_host_candidates_and_leaves_other_lines_alone(self) -> None:
        answer = "\r\n".join(
            [
                "v=0",
                "c=IN IP4 10.0.0.2",
                "a=candidate:1 1 udp 2130706431 10.0.0.2 53389 typ host",
                "a=candidate:2 1 udp 1694498815 203.0.113.10 62000 typ srflx raddr 10.0.0.2 rport 53389",
                "a=candidate:3 1 tcp 1518280447 10.0.0.2 9 typ host tcptype active",
                "a=end-of-candidates",
                "",
            ]
        )

        rewritten = rewrite_control_answer_host_candidates(
            answer,
            preferred_host="public.example.test:8082",
        )

        self.assertIn("c=IN IP4 10.0.0.2", rewritten)
        self.assertIn("public.example.test 53389 typ host", rewritten)
        self.assertIn("public.example.test 9 typ host tcptype active", rewritten)
        self.assertIn(
            "a=candidate:2 1 udp 1694498815 203.0.113.10 62000 typ srflx raddr 10.0.0.2 rport 53389",
            rewritten,
        )
        self.assertNotIn("10.0.0.2 53389 typ host", rewritten)
        self.assertTrue(rewritten.endswith("\r\n"))

    def test_describe_host_candidates_counts_only_host_candidates(self) -> None:
        answer = "\r\n".join(
            [
                "v=0",
                "a=candidate:1 1 udp 2130706431 10.0.0.2 53389 typ host",
                "a=candidate:2 1 udp 1694498815 203.0.113.10 62000 typ srflx raddr 10.0.0.2 rport 53389",
                "a=candidate:3 1 tcp 1518280447 10.0.0.2 9 typ host tcptype active",
                "",
            ]
        )

        self.assertEqual(describe_host_candidates(answer), {"host_candidate_count": 2})


if __name__ == "__main__":
    unittest.main()
