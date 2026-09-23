"""The GISA memo sanitizer and its plain-text mirror (no database)."""

from __future__ import annotations

import pytest

from app.services.rich_text import memo_plain_text, sanitize_memo_html


def test_script_handlers_and_unsafe_links_are_removed():
    html = sanitize_memo_html(
        '<p onclick="x()">Hi<script>alert(1)</script><img src=x onerror=alert(1)>'
        '<a href="javascript:alert(1)">bad</a><a href="https://dot.ca.gov">ok</a></p>'
    )
    assert "script" not in html and "onclick" not in html and "onerror" not in html and "javascript:" not in html
    assert 'href="https://dot.ca.gov"' in html and 'rel="noopener noreferrer"' in html


def test_word_processor_formatting_survives():
    html = sanitize_memo_html(
        '<p style="margin-left: 4em; line-height: 1.5; position: fixed">Indented</p>'
        '<p><span style="font-family: Georgia, serif; font-size: 14pt; color: #b91c1c">styled</span>'
        '<sub>2</sub><sup>3</sup></p>'
        '<table><tbody><tr><td colspan="2" style="background-color: #fff2cc">cell</td></tr></tbody></table>'
        '<pre><code>code</code></pre>'
    )
    assert "margin-left:4em" in html.replace(" ", "") and "line-height:1.5" in html.replace(" ", "")
    assert "position" not in html
    assert "font-family" in html and "font-size" in html and "<sub>2</sub>" in html and "<sup>3</sup>" in html
    assert 'colspan="2"' in html and "background-color" in html and "<pre><code>" in html


def test_checklists_keep_their_state_and_read_as_boxes():
    html = sanitize_memo_html(
        '<ul data-type="taskList">'
        '<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>Survey done</p></div></li>'
        '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Drill</p></div></li>'
        "</ul>"
    )
    assert 'data-type="taskList"' in html and 'data-checked="true"' in html and "<input" not in html
    assert memo_plain_text(html) == "☑ Survey done\n☐ Drill"


def test_lists_headings_and_tables_read_naturally():
    text = memo_plain_text(
        "<h2>Findings</h2><ul><li><p>Crack A</p></li><li><p>Crack B</p></li></ul>"
        "<ol><li><p>First</p></li><li><p>Second</p></li></ol><table><tr><td>a</td><td>b</td></tr></table>"
    )
    assert text == "Findings\n• Crack A\n• Crack B\n1. First\n2. Second\na\tb"


def test_an_oversized_memo_is_refused():
    with pytest.raises(ValueError):
        sanitize_memo_html("<p>" + "x" * 210_000 + "</p>")
