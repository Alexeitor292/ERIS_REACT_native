"""Rich-text memos on the GISA form: sanitizing and plain-text mirrors.

The web app edits Observations, Geotechnical assessment, Recommendations and
Sketch notes as formatted documents (HTML). Each is stored twice:

* ``<field>_html`` — the formatted document, sanitized here against a fixed
  allow-list, so nothing stored can run script in anyone's browser;
* ``<field>`` — a plain-text mirror derived from it, which the GISA PDF, the
  submit checks and the mobile app keep reading unchanged.

The mirror is always derived on the server from the sanitized HTML, so the two
cannot drift through the web app. If the mobile app later edits the plain text,
the web app notices the mismatch and starts from the plain text.
"""

from __future__ import annotations

from html.parser import HTMLParser

import nh3

MAX_MEMO_HTML_BYTES = 200_000
# The plain mirror lives in a TEXT column (65,535 bytes); stay well inside it.
MAX_MIRROR_CHARS = 60_000

_TAGS = {
    "p", "br", "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "strike", "mark", "span",
    "a", "ul", "ol", "li", "blockquote", "pre", "code", "hr", "sub", "sup",
    "table", "thead", "tbody", "tr", "th", "td", "colgroup", "col",
}
_STYLED = {"p", "h1", "h2", "h3", "h4", "span", "mark", "td", "th", "li"}
_ATTRIBUTES: dict[str, set[str]] = {tag: {"style"} for tag in _STYLED}
_ATTRIBUTES["a"] = {"href", "target"}
_ATTRIBUTES["td"] = {"style", "colspan", "rowspan", "colwidth"}
_ATTRIBUTES["th"] = {"style", "colspan", "rowspan", "colwidth"}
_ATTRIBUTES["col"] = {"style", "span"}
_ATTRIBUTES["mark"] = {"style", "data-color"}
_ATTRIBUTES["ol"] = {"start"}
_STYLE_PROPERTIES = {"color", "background-color", "text-align", "font-size", "font-family", "line-height", "width", "min-width"}
_URL_SCHEMES = {"http", "https", "mailto"}


def sanitize_memo_html(html: str | None) -> str | None:
    """The stored form of a memo: allow-listed tags, attributes, styles and links."""
    if html is None:
        return None
    if len(html.encode("utf-8")) > MAX_MEMO_HTML_BYTES:
        raise ValueError("memo is too large")
    cleaned = nh3.clean(
        html,
        tags=_TAGS,
        attributes=_ATTRIBUTES,
        url_schemes=_URL_SCHEMES,
        filter_style_properties=_STYLE_PROPERTIES,
        link_rel="noopener noreferrer",
    ).strip()
    return cleaned or None


_BLOCKS = {"p", "div", "h1", "h2", "h3", "h4", "blockquote", "pre", "li", "tr", "table", "ul", "ol", "hr"}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._list_stack: list[list[int] | None] = []
        # Just wrote a list marker: the item's first block stays on its line.
        self._after_marker = False

    def handle_starttag(self, tag, attrs):
        if tag in ("ul", "ol"):
            start = dict(attrs).get("start")
            self._list_stack.append([int(start) if start and start.isdigit() else 1] if tag == "ol" else None)
        elif tag == "li":
            self._newline()
            counter = self._list_stack[-1] if self._list_stack else None
            if counter is None:
                self.parts.append("• ")
            else:
                self.parts.append(f"{counter[0]}. ")
                counter[0] += 1
            self._after_marker = True
        elif tag == "br":
            self.parts.append("\n")
        elif tag in ("td", "th"):
            if self.parts and not self.parts[-1].endswith(("\n", "\t")):
                self.parts.append("\t")
        elif tag in _BLOCKS:
            self._newline()

    def handle_endtag(self, tag):
        if tag in ("ul", "ol") and self._list_stack:
            self._list_stack.pop()
        if tag in _BLOCKS:
            self._newline()

    def handle_data(self, data):
        if data.strip():
            self._after_marker = False
        self.parts.append(data)

    def _newline(self):
        if self._after_marker:
            return
        if self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")


def memo_plain_text(html: str | None) -> str | None:
    """Readable plain text of a memo: paragraphs on their own lines, list bullets and numbers kept."""
    if not html:
        return None
    parser = _TextExtractor()
    parser.feed(html)
    parser.close()
    lines = [" ".join(line.split()) if "\t" not in line else line.strip() for line in "".join(parser.parts).split("\n")]
    text = "\n".join(lines)
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    text = text.strip()
    return text[:MAX_MIRROR_CHARS] or None
