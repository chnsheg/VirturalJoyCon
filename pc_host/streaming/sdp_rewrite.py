from collections.abc import Iterable


def extract_host_only(host_value: str) -> str:
    host_text = str(host_value or "").strip()
    if not host_text:
        return ""

    if host_text.startswith("[") and "]" in host_text:
        return host_text[1:host_text.index("]")]

    if host_text.count(":") == 1:
        host_name, port_text = host_text.rsplit(":", 1)
        if port_text.isdigit():
            return host_name

    return host_text


_extract_host_only = extract_host_only


def _parse_candidate_parts(line: str) -> list[str] | None:
    candidate_prefix = "a=candidate:"
    if not line.startswith(candidate_prefix):
        return None

    parts = line[len(candidate_prefix):].split()
    if len(parts) < 6:
        return None
    return parts


def _candidate_host_from_sdp_line(line: str) -> str | None:
    parts = _parse_candidate_parts(line)
    if parts is None:
        return None
    return parts[4]


def _is_host_candidate_parts(parts: Iterable[str]) -> bool:
    parts_list = list(parts)
    return len(parts_list) >= 8 and parts_list[6] == "typ" and parts_list[7] == "host"


def _rewrite_candidate_host(line: str, preferred_host: str) -> str:
    parts = _parse_candidate_parts(line)
    if parts is None or not _is_host_candidate_parts(parts):
        return line

    parts[4] = preferred_host
    return "a=candidate:" + " ".join(parts)


def filter_or_rewrite_media_answer(answer_sdp: str, preferred_host: str) -> str:
    host_text = extract_host_only(preferred_host)
    if not host_text:
        return answer_sdp

    filtered_lines: list[str] = []
    removed_any = False
    kept_matching_candidate = False

    for raw_line in answer_sdp.splitlines():
        line = raw_line.rstrip("\r")
        candidate_host = _candidate_host_from_sdp_line(line)
        if candidate_host is None:
            filtered_lines.append(line)
            continue

        if candidate_host == host_text:
            filtered_lines.append(line)
            kept_matching_candidate = True
        else:
            removed_any = True

    if not removed_any:
        return answer_sdp

    if not kept_matching_candidate:
        rewritten_lines = [
            _rewrite_candidate_host(line.rstrip("\r"), preferred_host=host_text)
            for line in answer_sdp.splitlines()
        ]
        trailing_newline = "\r\n" if answer_sdp.endswith(("\r\n", "\n")) else ""
        return "\r\n".join(rewritten_lines) + trailing_newline

    trailing_newline = "\r\n" if answer_sdp.endswith(("\r\n", "\n")) else ""
    return "\r\n".join(filtered_lines) + trailing_newline


def rewrite_control_answer_host_candidates(answer_sdp: str, preferred_host: str) -> str:
    host_text = extract_host_only(preferred_host)
    if not host_text:
        return answer_sdp

    rewritten_lines = [
        _rewrite_candidate_host(line.rstrip("\r"), preferred_host=host_text)
        for line in answer_sdp.splitlines()
    ]
    trailing_newline = "\r\n" if answer_sdp.endswith(("\r\n", "\n")) else ""
    return "\r\n".join(rewritten_lines) + trailing_newline


def describe_host_candidates(answer_sdp: str) -> dict[str, int]:
    host_candidate_count = 0
    for raw_line in answer_sdp.splitlines():
        parts = _parse_candidate_parts(raw_line.rstrip("\r"))
        if parts is not None and _is_host_candidate_parts(parts):
            host_candidate_count += 1

    return {"host_candidate_count": host_candidate_count}
